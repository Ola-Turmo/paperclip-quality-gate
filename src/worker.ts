import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
  type Issue,
  type ToolResult,
} from "@paperclipai/plugin-sdk";
import {
  DEFAULT_CONFIG,
  PLUGIN_ID,
  PLUGIN_VERSION,
} from "./manifest.js";
import type {
  ActionResult,
  AgentRunFinishedEvent,
  ApproveParams,
  IssueCreatedEvent,
  IssueUpdatedEvent,
  QualityGateSettings,
  RejectParams,
  ReviewsListData,
  SubmitForReviewParams,
} from "./types.js";
import {
  buildApproveComment,
  buildAutoRejectComment,
  buildNewReview,
  buildRejectComment,
  buildSubmitComment,
  evaluateQuality,
  mapTargetStatus,
  STATE_KEYS,
  updateReviewStatus,
} from "./helpers.js";
import type { DeliverableReview, ReviewStatus, ReviewStatusData } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Type-safe params cast for action handlers.
 * The SDK passes params as Record<string, unknown>, but we know the shape at runtime.
 * Using as unknown as to suppress TypeScript's conservative overlap check — safe because
 * the action schema enforces required fields at registration time.
 */
function castParams<T>(params: Record<string, unknown>): T {
  return params as unknown as T;
}

async function getConfig(ctx: PluginContext): Promise<QualityGateSettings> {
  const config = await ctx.config.get();
  return { ...DEFAULT_CONFIG, ...(config as Partial<QualityGateSettings>) };
}

async function getReview(
  ctx: PluginContext,
  issueId: string,
): Promise<DeliverableReview | null> {
  const review = await ctx.state.get({
    scopeKind: "issue" as const,
    scopeId: issueId,
    stateKey: STATE_KEYS.REVIEWS,
  });
  return (review as DeliverableReview | null) ?? null;
}

async function putReview(
  ctx: PluginContext,
  review: DeliverableReview,
): Promise<void> {
  // Per-issue atomic state — concurrent writes on different issues never contend.
  await ctx.state.set(
    { scopeKind: "issue" as const, scopeId: review.issueId, stateKey: STATE_KEYS.REVIEWS },
    review,
  );
  // Maintain a company-level index of review IDs for list queries
  const indexKey = {
    scopeKind: "company" as const,
    scopeId: review.companyId,
    stateKey: STATE_KEYS.REVIEW_IDS,
  };
  const ids = ((await ctx.state.get(indexKey)) as string[] | null) ?? [];
  const next = ids.includes(review.id)
    ? ids
    : [review.id, ...ids].slice(0, 200);
  await ctx.state.set(indexKey, next);
}

// ── Worker ────────────────────────────────────────────────────────────────────

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_ID} v${PLUGIN_VERSION} starting up`);

    // ── Data registrations ────────────────────────────────────────────────────

    ctx.data.register("quality_gate.config", async () => {
      return await getConfig(ctx);
    });

    ctx.data.register("quality_gate.review", async (params) => {
      const issueId = params["issueId"] as string;
      if (!issueId) return null;

      let review: DeliverableReview | null = null;
      try {
        review = await getReview(ctx, issueId);
      } catch {
        return null;
      }
      if (!review) return null;

      let issue: Issue | null = null;
      try {
        if (review.companyId) {
          issue = await ctx.issues.get(issueId, review.companyId);
        }
      } catch {
        // issue may have been deleted — return review without issue
      }

      const data: ReviewStatusData = { review };
      if (issue) {
        data.issue = { id: issue.id, title: issue.title, status: issue.status ?? undefined };
      }
      return data;
    });

    ctx.data.register("quality_gate.reviews", async (params) => {
      const companyId = (params["companyId"] as string) ?? "";
      if (!companyId) return { reviews: [], total: 0 };

      const ids = ((await ctx.state.get({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: STATE_KEYS.REVIEW_IDS,
      })) as string[] | null) ?? [];

      const idslice = ids.slice(0, 50);

      // Parallel fetch with concurrency limit of 10
      const CONCURRENCY = 10;
      const results: ReviewStatusData[] = [];
      for (let i = 0; i < idslice.length; i += CONCURRENCY) {
        const batch = idslice.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(
          batch.map(async (reviewId): Promise<ReviewStatusData | null> => {
            const parts = reviewId.split("_");
            const issueId = parts[1];
            if (!issueId) return null;

            try {
              const review = await getReview(ctx, issueId);
              if (!review) return null;
              let issue: Issue | null = null;
              try {
                issue = await ctx.issues.get(issueId, companyId);
              } catch {
                // issue deleted — still surface the review
              }
              return {
                review,
                issue: issue
                  ? { id: issue.id, title: issue.title, status: issue.status ?? "" }
                  : undefined,
              } as ReviewStatusData;
            } catch {
              // skip corrupted review
              return null;
            }
          }),
        );
        for (const r of batchResults) {
          if (r) results.push(r);
        }
      }

      return { reviews: results, total: ids.length } as ReviewsListData;
    });

    // ── Action registrations ─────────────────────────────────────────────────

    /**
     * quality_gate.submit — evaluate a deliverable and create/update a review.
     * Idempotent: submitting the same issue again updates the existing review.
     */
    ctx.actions.register("quality_gate.submit", async (params) => {
      const p = castParams<SubmitForReviewParams>(params);
      const issueId = p.issue_id;
      if (!issueId) {
        return { ok: false, error: "issue_id is required" } as ActionResult;
      }

      const cfg = await getConfig(ctx);

      let companyId = "";
      let existingReview: DeliverableReview | null = null;
      try {
        const issue = await ctx.issues.get(issueId, "");
        companyId = issue?.companyId ?? "";
        if (companyId) {
          existingReview = await getReview(ctx, issueId);
        }
      } catch (err) {
        ctx.logger.warn("quality_gate.submit: could not load issue", { issueId, error: String(err) });
        return { ok: false, error: "Issue not found" } as ActionResult;
      }

      const evaluation = evaluateQuality(
        p.quality_score,
        p.block_approval ?? false,
        cfg,
      );

      let reviewStatus: ReviewStatus = "pending_review";
      if (evaluation.autoRejected) {
        reviewStatus = "auto_rejected";
      } else if (evaluation.blockThresholdBreached) {
        reviewStatus = "needs_human_review";
      }

      let review: DeliverableReview;
      if (existingReview) {
        review = updateReviewStatus(existingReview, reviewStatus, {
          action: "resubmitted",
          reviewer: "user",
          reviewerName: "User",
          comment: p.comment,
          qualityScore: evaluation.overallScore,
          auto: false,
        });
      } else {
        review = buildNewReview({
          issueId,
          companyId,
          summary: p.summary,
          qualityScore: evaluation.overallScore,
          blockApproval: p.block_approval ?? false,
          reviewerName: "User",
          qualityChecks: evaluation.checks,
          evaluationSummary: evaluation.summary,
          category: evaluation.category,
        });
      }

      await putReview(ctx, review);

      const targetStatus = mapTargetStatus(evaluation.category);

      if (companyId && targetStatus) {
        try {
          await ctx.issues.update(
            issueId,
            { status: targetStatus as Issue["status"] },
            companyId,
          );
        } catch (err) {
          ctx.logger.warn("quality_gate.submit: failed to update issue status", { error: String(err) });
        }
        try {
          await ctx.issues.createComment(
            issueId,
            buildSubmitComment({
              qualityScore: evaluation.overallScore,
              evaluationSummary: evaluation.summary,
              blockApproval: p.block_approval,
              qualityChecks: evaluation.checks,
            }),
            companyId,
          );
        } catch (err) {
          ctx.logger.warn("quality_gate.submit: failed to post comment", { error: String(err) });
        }
      }

      if (!existingReview) {
        ctx.streams.emit("quality_gate.review_created", { review });
      }
      ctx.streams.emit("quality_gate.review_updated", { review });

      if (evaluation.autoRejected) {
        ctx.streams.emit("quality_gate.threshold_breached", {
          review,
          score: evaluation.overallScore,
          reason: "auto_rejected",
        });
      } else if (evaluation.blockThresholdBreached) {
        ctx.streams.emit("quality_gate.threshold_breached", {
          review,
          score: evaluation.overallScore,
          reason: "block_threshold",
        });
      }

      ctx.logger.info("quality_gate.submit: review created/updated", {
        issueId,
        status: reviewStatus,
        score: evaluation.overallScore,
        category: evaluation.category,
      });

      return { ok: true, review } as ActionResult<DeliverableReview>;
    });

    /**
     * quality_gate.approve — approve a deliverable (human reviewer).
     * Idempotent: double-approve is a no-op, not an error.
     */
    ctx.actions.register("quality_gate.approve", async (params) => {
      const p = castParams<ApproveParams>(params);
      const issueId = p.issue_id;
      if (!issueId) {
        return { ok: false, error: "issue_id is required" } as ActionResult;
      }

      const review = await getReview(ctx, issueId);
      if (!review) {
        return { ok: false, error: "No review found for this issue" } as ActionResult;
      }

      if (review.status === "approved") {
        return { ok: true, review, message: "Already approved" } as ActionResult<DeliverableReview>;
      }

      const updated = updateReviewStatus(review, "approved", {
        action: "approved",
        reviewer: "user",
        reviewerName: "Reviewer",
        comment: p.comment,
        auto: false,
      });
      await putReview(ctx, updated);

      if (updated.companyId) {
        try {
          await ctx.issues.update(
            issueId,
            { status: "done" as Issue["status"] },
            updated.companyId,
          );
        } catch (err) {
          ctx.logger.warn("quality_gate.approve: failed to update issue", { error: String(err) });
        }
        try {
          await ctx.issues.createComment(
            issueId,
            buildApproveComment(p.comment),
            updated.companyId,
          );
        } catch (err) {
          ctx.logger.warn("quality_gate.approve: failed to post comment", { error: String(err) });
        }
        try {
          await ctx.activity.log({
            companyId: updated.companyId,
            message: `Quality gate approved for issue ${issueId}`,
            entityType: "issue",
            entityId: issueId,
          });
        } catch {
          // activity not available
        }
        try {
          await ctx.metrics.write("quality_gate.reviews.approved", 1, {
            companyId: updated.companyId,
          });
        } catch {
          // metrics not available
        }
      }

      ctx.streams.emit("quality_gate.review_approved", { review: updated });

      ctx.logger.info("quality_gate.approve: issue approved", { issueId });
      return { ok: true, review: updated } as ActionResult<DeliverableReview>;
    });

    /**
     * quality_gate.reject — reject a deliverable (human reviewer).
     * Idempotent: double-reject is a no-op.
     */
    ctx.actions.register("quality_gate.reject", async (params) => {
      const p = castParams<RejectParams>(params);
      const issueId = p.issue_id;
      if (!issueId) {
        return { ok: false, error: "issue_id is required" } as ActionResult;
      }
      if (!p.comment) {
        return { ok: false, error: "comment is required when rejecting" } as ActionResult;
      }

      const review = await getReview(ctx, issueId);
      if (!review) {
        return { ok: false, error: "No review found for this issue" } as ActionResult;
      }

      if (review.status === "rejected") {
        return { ok: true, review, message: "Already rejected" } as ActionResult<DeliverableReview>;
      }

      const updated = updateReviewStatus(review, "rejected", {
        action: "rejected",
        reviewer: "user",
        reviewerName: "Reviewer",
        comment: p.comment,
        auto: false,
      });
      await putReview(ctx, updated);

      if (updated.companyId) {
        try {
          await ctx.issues.update(
            issueId,
            { status: "in_progress" as Issue["status"] },
            updated.companyId,
          );
        } catch (err) {
          ctx.logger.warn("quality_gate.reject: failed to update issue", { error: String(err) });
        }
        try {
          await ctx.issues.createComment(
            issueId,
            buildRejectComment(p.comment),
            updated.companyId,
          );
        } catch (err) {
          ctx.logger.warn("quality_gate.reject: failed to post comment", { error: String(err) });
        }
        try {
          await ctx.activity.log({
            companyId: updated.companyId,
            message: `Quality gate rejected for issue ${issueId}`,
            entityType: "issue",
            entityId: issueId,
          });
        } catch {
          // activity not available
        }
        try {
          await ctx.metrics.write("quality_gate.reviews.rejected", 1, {
            companyId: updated.companyId,
          });
        } catch {
          // metrics not available
        }
      }

      ctx.streams.emit("quality_gate.review_rejected", { review: updated });

      ctx.logger.info("quality_gate.reject: issue rejected", { issueId });
      return { ok: true, review: updated } as ActionResult<DeliverableReview>;
    });

    // ── Tool registrations ────────────────────────────────────────────────────

    /**
     * quality_gate_review — agent tool: check review status for an issue.
     */
    ctx.tools.register(
      "quality_gate_review",
      {
        displayName: "Quality Gate — Check Review Status",
        description:
          "Check the quality gate review status for a Paperclip issue. " +
          "Returns the current review state, quality score, check breakdown, " +
          "and audit history. Does not modify any state.",
        parametersSchema: {
          type: "object",
          properties: {
            issue_id: {
              type: "string",
              description: "The Paperclip issue ID to check the review status for.",
            },
            include_checks: {
              type: "boolean",
              description: "If true, includes the full per-check quality breakdown. Default: false.",
              default: false,
            },
          },
          required: ["issue_id"],
        },
      },
      async (params: unknown) => {
        const p = params as { issue_id: string; include_checks?: boolean };
        const issueId = p.issue_id;
        if (!issueId) {
          return { content: "Error: issue_id is required." };
        }

        const review = await getReview(ctx, issueId);
        if (!review) {
          return { content: `No quality gate review found for issue ${issueId}.` };
        }

        const lines = [
          `## Quality Gate Review — ${issueId}`,
          "",
          `**Status:** ${review.status}`,
          `**Score:** ${review.qualityScore}/10`,
          `**Category:** ${review.category}`,
          `**Submitter:** ${review.submitterName}`,
          "",
          `> ${review.evaluationSummary}`,
          "",
          `Submitted: ${new Date(review.createdAt).toLocaleString()}`,
          `Updated: ${new Date(review.updatedAt).toLocaleString()}`,
        ];

        if (p.include_checks && review.checks.length > 0) {
          lines.push("", "### Quality Checks");
          for (const check of review.checks) {
            const icon = check.passed ? "✅" : "❌";
            lines.push(
              `${icon} **${check.name}** — ${check.details ?? ""} (score: ${check.score})`,
            );
          }
        }

        if (review.history.length > 0) {
          lines.push("", "### History");
          for (const entry of review.history.slice(-5)) {
            lines.push(
              `- ${entry.createdAt.slice(0, 10)} · **${entry.action}** · ${entry.reviewerName}` +
              (entry.comment ? ` — "${entry.comment.slice(0, 80)}"` : ""),
            );
          }
        }

        return { content: lines.join("\n") };
      },
    );

    /**
     * submit_for_review — agent tool: submit completed work for quality review.
     */
    ctx.tools.register(
      "submit_for_review",
      {
        displayName: "Quality Gate — Submit for Review",
        description:
          "Submit a completed deliverable for quality gate review. " +
          "Runs the quality evaluation, creates or updates the review record, " +
          "and posts a comment on the issue.",
        parametersSchema: {
          type: "object",
          properties: {
            issue_id: {
              type: "string",
              description: "The Paperclip issue ID to submit for review.",
            },
            summary: {
              type: "string",
              description: "Brief summary of what was delivered.",
            },
            quality_score: {
              type: "number",
              description: "Self-assessed quality score from 0–10.",
            },
            block_approval: {
              type: "boolean",
              description: "If true, forces human review regardless of quality score.",
              default: false,
            },
            comment: {
              type: "string",
              description: "Optional comment to attach to the review submission.",
            },
          },
          required: ["issue_id"],
        },
      },
      async (params: unknown) => {
        const p = params as {
          issue_id: string;
          summary?: string;
          quality_score?: number;
          block_approval?: boolean;
          comment?: string;
        };
        const issueId = p.issue_id;
        if (!issueId) {
          return { content: "Error: issue_id is required.", error: "missing_param" };
        }

        const cfg = await getConfig(ctx);
        let companyId = "";
        try {
          const issue = await ctx.issues.get(issueId, "");
          companyId = issue?.companyId ?? "";
        } catch {
          return { content: `Error: Issue ${issueId} not found.`, error: "not_found" };
        }

        const existingReview = await getReview(ctx, issueId);
        const evaluation = evaluateQuality(p.quality_score, p.block_approval ?? false, cfg);

        let reviewStatus: ReviewStatus = "pending_review";
        if (evaluation.autoRejected) {
          reviewStatus = "auto_rejected";
        } else if (evaluation.blockThresholdBreached) {
          reviewStatus = "needs_human_review";
        }

        let review: DeliverableReview;
        if (existingReview) {
          review = updateReviewStatus(existingReview, reviewStatus, {
            action: "resubmitted",
            reviewer: "user",
            reviewerName: "Agent",
            comment: p.comment,
            qualityScore: evaluation.overallScore,
            auto: false,
          });
        } else {
          review = buildNewReview({
            issueId,
            companyId,
            summary: p.summary,
            qualityScore: evaluation.overallScore,
            blockApproval: p.block_approval,
            reviewerName: "Agent",
            qualityChecks: evaluation.checks,
            evaluationSummary: evaluation.summary,
            category: evaluation.category,
          });
        }

        await putReview(ctx, review);

        const targetStatus = mapTargetStatus(evaluation.category);

        if (companyId && targetStatus) {
          try {
            await ctx.issues.update(
              issueId,
              { status: targetStatus as Issue["status"] },
              companyId,
            );
          } catch (err) {
            ctx.logger.warn("submit_for_review: failed to update issue status", { error: String(err) });
          }
          try {
            await ctx.issues.createComment(
              issueId,
              buildSubmitComment({
                qualityScore: evaluation.overallScore,
                evaluationSummary: evaluation.summary,
                blockApproval: p.block_approval,
                qualityChecks: evaluation.checks,
              }),
              companyId,
            );
          } catch (err) {
            ctx.logger.warn("submit_for_review: failed to post comment", { error: String(err) });
          }
        }

        if (!existingReview) {
          ctx.streams.emit("quality_gate.review_created", { review });
        }
        ctx.streams.emit("quality_gate.review_updated", { review });

        if (evaluation.autoRejected) {
          ctx.streams.emit("quality_gate.threshold_breached", {
            review,
            score: evaluation.overallScore,
            reason: "auto_rejected",
          });
        } else if (evaluation.blockThresholdBreached) {
          ctx.streams.emit("quality_gate.threshold_breached", {
            review,
            score: evaluation.overallScore,
            reason: "block_threshold",
          });
        }

        const emoji = review.status === "auto_rejected" ? "⚠️"
          : review.status === "needs_human_review" ? "🛡️"
          : "✅";

        return {
          content: [
            `${emoji} Quality gate review submitted for issue ${issueId}`,
            "",
            `Status: ${review.status}`,
            `Score: ${review.qualityScore}/10`,
            `Category: ${review.category}`,
            "",
            review.evaluationSummary,
          ].join("\n"),
        };
      },
    );

    // ── Event subscriptions ─────────────────────────────────────────────────

    /**
     * agent.run.finished — auto-evaluate after agent run completes.
     * Runs quality evaluation and creates/updates review automatically.
     * Does NOT auto-reject or auto-approve — always sets in_review or needs_human_review.
     */
    ctx.events.on("agent.run.finished", async (event: PluginEvent) => {
      const runId = event.entityId ?? "";
      const companyId = event.companyId ?? "";
      const payload = event.payload as unknown as AgentRunFinishedEvent;
      const { agentId, status, summary, qualityScore, blockApproval } = payload;

      if (!runId || !companyId) {
        ctx.logger.info("agent.run.finished: missing runId or companyId, skipping", { runId, companyId });
        return;
      }

      if (status === "failed") {
        ctx.logger.info("agent.run.finished: run failed, skipping auto-gate", { runId, status });
        return;
      }

      // Find the issue this run was for
      let issueId = "";
      try {
        const issues = await ctx.issues.list({ companyId, limit: 50 });
        const matched = issues.find(
          (issue) =>
            (issue as { executionRunId?: string; checkoutRunId?: string }).executionRunId === runId ||
            (issue as { executionRunId?: string; checkoutRunId?: string }).checkoutRunId === runId,
        );
        issueId = matched?.id ?? "";
      } catch (err) {
        ctx.logger.warn("agent.run.finished: failed to list issues", { error: String(err) });
      }

      if (!issueId) {
        ctx.logger.info("agent.run.finished: no issue found for this runId, skipping", { runId });
        return;
      }

      const cfg = await getConfig(ctx);
      const evaluation = evaluateQuality(qualityScore, blockApproval ?? false, cfg);

      // Determine new review status from evaluation (not the old status)
      let reviewStatus: ReviewStatus = "pending_review";
      if (evaluation.autoRejected) {
        reviewStatus = "auto_rejected";
      } else if (evaluation.blockThresholdBreached) {
        reviewStatus = "needs_human_review";
      }

      // Check if review already exists
      let review = await getReview(ctx, issueId);
      const isNew = review === null;

      if (isNew) {
        review = buildNewReview({
          issueId,
          companyId,
          summary,
          qualityScore: evaluation.overallScore,
          blockApproval: blockApproval ?? false,
          reviewerName: "Agent",
          qualityChecks: evaluation.checks,
          evaluationSummary: evaluation.summary,
          category: evaluation.category,
        });
      } else {
        review = updateReviewStatus(review!, reviewStatus, {
          action: `auto-evaluated after agent.run.finished (resumed)`,
          reviewer: "agent",
          reviewerName: "System",
          comment: evaluation.summary,
          qualityScore: evaluation.overallScore,
          auto: true,
        });
      }

      await putReview(ctx, review);

      const targetStatus = mapTargetStatus(evaluation.category);

      try {
        if (targetStatus) {
          await ctx.issues.update(
            issueId,
            { status: targetStatus as Issue["status"] },
            companyId,
          );
        }
      } catch (err) {
        ctx.logger.warn("agent.run.finished: failed to update issue status", { error: String(err) });
      }

      try {
        await ctx.issues.createComment(
          issueId,
          buildSubmitComment({
            qualityScore: evaluation.overallScore,
            evaluationSummary: evaluation.summary,
            blockApproval: blockApproval ?? false,
            qualityChecks: evaluation.checks,
          }),
          companyId,
        );
      } catch (err) {
        ctx.logger.warn("agent.run.finished: failed to post comment", { error: String(err) });
      }

      try {
        await ctx.activity.log({
          companyId,
          message: `Quality gate auto-evaluated after run ${runId} (agent ${agentId})`,
          entityType: "issue",
          entityId: issueId,
        });
      } catch {
        // activity not available
      }

      try {
        await ctx.metrics.write("quality_gate.reviews.auto_evaluated", 1, { companyId });
      } catch {
        // metrics not available
      }

      if (isNew) {
        ctx.streams.emit("quality_gate.review_created", { review });
      }
      ctx.streams.emit("quality_gate.review_updated", { review });

      ctx.logger.info("agent.run.finished: auto-gate complete", {
        issueId,
        runId,
        score: evaluation.overallScore,
        category: evaluation.category,
        status: review.status,
      });
    });

    /**
     * agent.run.failed — log failed runs; skip auto-gate since no deliverable was produced.
     */
    ctx.events.on("agent.run.failed", async (event: PluginEvent) => {
      const runId = event.entityId ?? "";
      const companyId = event.companyId ?? "";
      ctx.logger.info("agent.run.failed observed", {
        runId,
        companyId,
        event: event.payload,
      });
    });

    /**
     * issue.created — observe new issues being created.
     */
    ctx.events.on("issue.created", async (event: PluginEvent) => {
      const payload = event.payload as unknown as IssueCreatedEvent;
      const issue = payload.issue;
      ctx.logger.info("issue.created observed", {
        issueId: issue.id,
        status: issue.status,
        companyId: event.companyId,
      });
    });

    /**
     * issue.updated — log status changes for audit trail.
     * Review state is updated reactively via quality_gate.submit / approve / reject.
     */
    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      const payload = event.payload as unknown as IssueUpdatedEvent;
      const { issue } = payload;
      ctx.logger.info("issue.updated observed", {
        issueId: issue.id,
        status: issue.status,
        previousStatus: payload.previousStatus,
        companyId: event.companyId,
      });
    });

    ctx.logger.info(`${PLUGIN_ID} setup complete`);
  },

  async onHealth() {
    return { status: "ok", version: PLUGIN_VERSION };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
