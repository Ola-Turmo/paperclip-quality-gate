import type {
  ApproveParams,
  CommentCreatedEvent,
  IssueCreatedEvent,
  IssueUpdatedEvent,
  QualityGateReviewInput,
  QualityGateReviewOutput,
  RejectParams,
  ReviewHistoryData,
  ReviewStatusData,
  SubmitForReviewParams,
} from "./types.js";
import {
  buildNewReview,
  evaluateDeliverable,
  getConfig,
  getReview,
  putReview,
  updateReviewStatus,
} from "./helpers.js";

// =============================================================================
// Types for raw event payloads (SDK doesn't export typed event payloads)
// =============================================================================

interface IssuePayload {
  issue?: {
    id?: string;
    title?: string;
    status?: string;
  };
}

interface CommentPayload {
  issue?: { id?: string };
  comment?: { body?: string; authorName?: string };
}

type IssueEvent = PluginEvent<IssuePayload>;
type CommentEvent = PluginEvent<CommentPayload>;

// =============================================================================
// Comment text builders
// =============================================================================

function buildSubmitComment(review: {
  qualityScore?: number;
  evaluationSummary?: string;
  blockApproval: boolean;
  qualityChecks?: { category: string; score: number; message?: string }[];
}): string {
  const lines = [
    "## 📋 Quality Gate — Submitted for Review",
  ];
  if (review.qualityScore !== undefined) {
    lines.push(`**Quality Score:** ${review.qualityScore}/10`);
  }
  if (review.evaluationSummary) {
    lines.push(`**Evaluation:** ${review.evaluationSummary}`);
  }
  if (review.blockApproval) {
    lines.push("\n⚠️ **Note:** Agent flagged a known limitation — review required before approval.");
  }
  if (review.qualityChecks && review.qualityChecks.length > 0) {
    lines.push("\n**Category Breakdown:**");
    for (const check of review.qualityChecks) {
      lines.push(`- **${check.category}:** ${check.score}/10 — ${check.message ?? ""}`);
    }
  }
  return lines.join("\n");
}

function buildApproveComment(comment?: string): string {
  const lines = ["## ✅ Quality Gate — Approved"];
  if (comment) lines.push(`\n> ${comment}`);
  return lines.join("\n");
}

function buildRejectComment(comment: string): string {
  return [
    "## ❌ Quality Gate — Changes Requested",
    "",
    `> ${comment}`,
    "",
    "Please address the feedback above and resubmit for review.",
  ].join("\n");
}

// =============================================================================
// Issue status helpers
// =============================================================================

/** Map our internal review status to Paperclip issue status. */
function getTargetIssueStatus(review: { status: string; autoRejected?: boolean }): string {
  switch (review.status) {
    case "approved":
      return "done";
    case "rejected":
      return "in_progress"; // send back to in_progress so agent can retry
    case "pending_review":
      return "in_review";
    default:
      return "in_review";
  }
}

// =============================================================================
// Plugin Definition
// =============================================================================

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info("uos-quality-gate plugin starting");

    // -------------------------------------------------------------------------
    // Tool: quality_gate_review
    // -------------------------------------------------------------------------
    ctx.tools.register(
      "quality_gate_review",
      {
        name: "Quality Gate Review",
        description:
          "Submit a deliverable for quality review. Evaluates quality across " +
          "completeness, correctness, clarity, test coverage, and documentation. " +
          "Auto-rejects scores below the configured threshold. " +
          "Flags for human review if block_approval=true or score is below minimum.",
        inputJsonSchema: {
          type: "object",
          required: ["issue_id"],
          properties: {
            issue_id: {
              type: "string",
              description: "UUID of the issue this deliverable belongs to.",
            },
            deliverable_summary: {
              type: "string",
              description:
                "Plain-text summary of what was delivered — changes made, " +
                "files modified, decisions taken.",
            },
            quality_score: {
              type: "number",
              minimum: 0,
              maximum: 10,
              description:
                "Self-assessed overall quality score (0–10). " +
                "Below the configured minimum (default 7) triggers review.",
            },
            block_approval: {
              type: "boolean",
              description:
                "Set to true when there is a known limitation or open question " +
                "that should prevent automatic approval pending human review.",
            },
            self_assessment: {
              type: "object",
              description:
                "Optional per-category self-assessment. " +
                "enables more accurate quality evaluation than a single score.",
              properties: {
                completeness: {
                  type: "number",
                  minimum: 0,
                  maximum: 10,
                  description: "Coverage of all required scope items.",
                },
                correctness: {
                  type: "number",
                  minimum: 0,
                  maximum: 10,
                  description: "Likeliness of being bug-free and logically correct.",
                },
                clarity: {
                  type: "number",
                  minimum: 0,
                  maximum: 10,
                  description: "How clear and self-explanatory the deliverable is.",
                },
                test_coverage: {
                  type: "number",
                  minimum: 0,
                  maximum: 10,
                  description: "Adequacy of tests covering the deliverable.",
                },
                documentation: {
                  type: "number",
                  minimum: 0,
                  maximum: 10,
                  description: "Quality of accompanying documentation.",
                },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
      },
      async (
        params: QualityGateReviewInput,
        runCtx,
      ): Promise<QualityGateReviewOutput> => {
        const {
          issue_id,
          deliverable_summary,
          quality_score,
          block_approval,
          self_assessment,
        } = params;

        ctx.logger.info("quality_gate_review called", { issueId: issue_id });

        const cfg = await getConfig(ctx);
        const existing = await getReview(ctx, issue_id);

        if (existing && existing.status !== "pending_review") {
          return {
            success: true,
            review: existing,
            evaluation: {
              overallScore: existing.qualityScore ?? 0,
              passed: existing.status === "approved",
              autoRejected: false,
              checks: existing.qualityChecks ?? [],
              blockers: [],
              summary: `Already ${existing.status}.`,
            },
            message: `Deliverable is already ${existing.status}.`,
          };
        }

        // Run quality evaluation
        const evaluation = evaluateDeliverable({
          deliverableSummary: deliverable_summary,
          qualityScore: quality_score,
          blockApproval: block_approval,
          selfAssessment: self_assessment,
          config: cfg,
        });

        const reviewerName = String(
          (runCtx as Record<string, unknown>)?.agentId ?? "Agent",
        );

        const review = existing
          ? updateReviewStatus(existing, "pending_review", {
              action: "re-submitted for review",
              reviewer: "agent",
              reviewerName,
              comment: deliverable_summary,
              qualityScore: evaluation.overallScore,
              auto: false,
            })
          : buildNewReview({
              issueId: issue_id,
              companyId: existing?.companyId ?? "",
              summary: deliverable_summary,
              qualityScore: evaluation.overallScore,
              blockApproval: block_approval ?? false,
              reviewerName,
              qualityChecks: evaluation.checks,
              evaluationSummary: evaluation.summary,
            });

        await putReview(ctx, review);

        // Post a comment on the issue with the evaluation summary
        try {
          if (review.companyId) {
            await ctx.issues.createComment({
              issueId: issue_id,
              companyId: review.companyId,
              body: buildSubmitComment({
                qualityScore: evaluation.overallScore,
                evaluationSummary: evaluation.summary,
                blockApproval: block_approval ?? false,
                qualityChecks: evaluation.checks,
              }),
            });
          }
        } catch (err) {
          ctx.logger.warn("Failed to post submit comment", { error: String(err) });
        }

        // Set issue to in_review
        try {
          if (review.companyId) {
            await ctx.issues.update(issue_id, { status: "in_review" }, review.companyId);
          }
        } catch (err) {
          ctx.logger.warn("Failed to update issue status to in_review", { error: String(err) });
        }

        // Auto-reject very low scores without human review
        if (evaluation.autoRejected) {
          const autoReview = updateReviewStatus(review, "rejected", {
            action: `auto-rejected (score ${evaluation.overallScore} below ${cfg.autoRejectBelow})`,
            reviewer: "agent",
            reviewerName: "System",
            comment: evaluation.summary,
            qualityScore: evaluation.overallScore,
            auto: true,
          });
          await putReview(ctx, autoReview);

          // Set issue back to in_progress so agent can address it
          try {
            if (autoReview.companyId) {
              await ctx.issues.update(issue_id, { status: "in_progress" }, autoReview.companyId);
              await ctx.issues.createComment({
                issueId: issue_id,
                companyId: autoReview.companyId,
                body: buildRejectComment(evaluation.summary),
              });
            }
          } catch (err) {
            ctx.logger.warn("Failed auto-reject update", { error: String(err) });
          }

          ctx.streams.emit("review_updated", review.companyId, {
            issueId: autoReview.issueId,
            review: autoReview,
          });

          return {
            success: true,
            review: autoReview,
            evaluation,
            message: evaluation.summary,
          };
        }

        // Emit stream event for real-time UI refresh
        ctx.streams.emit("review_updated", review.companyId || "", {
          issueId: review.issueId,
          review,
        });

        return {
          success: true,
          review,
          evaluation,
          message: evaluation.summary,
        };
      },
    );

    // -------------------------------------------------------------------------
    // Action: submit_for_review
    // -------------------------------------------------------------------------
    ctx.actions.register(
      "submit_for_review",
      {
        name: "Submit for Review",
        description: "Submit an issue's deliverable for quality review (user-initiated).",
        inputJsonSchema: {
          type: "object",
          required: ["issue_id"],
          properties: {
            issue_id: { type: "string" },
            summary: { type: "string" },
            quality_score: { type: "number", minimum: 0, maximum: 10 },
            block_approval: { type: "boolean" },
          },
        },
      },
      async (params: SubmitForReviewParams, _runCtx) => {
        const cfg = await getConfig(ctx);
        const issueId = params.issue_id;

        const evaluation = evaluateDeliverable({
          summary: params.summary,
          qualityScore: params.quality_score,
          blockApproval: params.block_approval,
          config: cfg,
        });

        // Need companyId — try to get it from the issue
        let companyId = "";
        try {
          const issue = await ctx.issues.get(issueId, "");
          companyId = (issue as Record<string, unknown>)?.["companyId"] as string ?? "";
        } catch {
          // fallback: use empty string for company-scoped state
        }

        const review = buildNewReview({
          issueId,
          companyId,
          summary: params.summary,
          qualityScore: params.quality_score,
          blockApproval: params.block_approval,
          reviewerName: "User",
          qualityChecks: evaluation.checks,
          evaluationSummary: evaluation.summary,
        });

        await putReview(ctx, review);

        // Update issue status to in_review
        if (companyId) {
          try {
            await ctx.issues.update(issueId, { status: "in_review" }, companyId);
          } catch (err) {
            ctx.logger.warn("submit_for_review: failed to update issue status", { error: String(err) });
          }
        }

        ctx.streams.emit("review_updated", companyId, {
          issueId: review.issueId,
          review,
        });

        return { ok: true, review, evaluation };
      },
    );

    // -------------------------------------------------------------------------
    // Action: approve_deliverable
    // -------------------------------------------------------------------------
    ctx.actions.register(
      "approve_deliverable",
      {
        name: "Approve Deliverable",
        description: "Approve a pending deliverable review.",
        inputJsonSchema: {
          type: "object",
          required: ["issue_id"],
          properties: {
            issue_id: { type: "string" },
            comment: { type: "string", description: "Optional review note." },
          },
        },
      },
      async (params: ApproveParams) => {
        const review = await getReview(ctx, params.issue_id);
        if (!review) {
          return { ok: false, error: "No review found for this issue." };
        }

        const updated = updateReviewStatus(review, "approved", {
          action: "approved",
          reviewer: "user",
          reviewerName: "Reviewer",
          comment: params.comment,
          auto: false,
        });

        await putReview(ctx, updated);

        // Update issue to done
        if (updated.companyId) {
          try {
            await ctx.issues.update(params.issue_id, { status: "done" }, updated.companyId);
            await ctx.issues.createComment({
              issueId: params.issue_id,
              companyId: updated.companyId,
              body: buildApproveComment(params.comment),
            });
          } catch (err) {
            ctx.logger.warn("approve_deliverable: failed to update issue", { error: String(err) });
          }
        }

        ctx.streams.emit("review_updated", updated.companyId || "", {
          issueId: updated.issueId,
          review: updated,
        });

        return { ok: true, review: updated };
      },
    );

    // -------------------------------------------------------------------------
    // Action: reject_deliverable
    // -------------------------------------------------------------------------
    ctx.actions.register(
      "reject_deliverable",
      {
        name: "Reject Deliverable",
        description: "Reject a pending deliverable and request revisions.",
        inputJsonSchema: {
          type: "object",
          required: ["issue_id", "comment"],
          properties: {
            issue_id: { type: "string" },
            comment: {
              type: "string",
              description: "Required reason for rejection, including what must be revised.",
            },
          },
        },
      },
      async (params: RejectParams) => {
        const review = await getReview(ctx, params.issue_id);
        if (!review) {
          return { ok: false, error: "No review found for this issue." };
        }

        const updated = updateReviewStatus(review, "rejected", {
          action: "rejected",
          reviewer: "user",
          reviewerName: "Reviewer",
          comment: params.comment,
          auto: false,
        });

        await putReview(ctx, updated);

        // Set issue back to in_progress so agent can address feedback
        if (updated.companyId) {
          try {
            await ctx.issues.update(params.issue_id, { status: "in_progress" }, updated.companyId);
            await ctx.issues.createComment({
              issueId: params.issue_id,
              companyId: updated.companyId,
              body: buildRejectComment(params.comment),
            });
          } catch (err) {
            ctx.logger.warn("reject_deliverable: failed to update issue", { error: String(err) });
          }
        }

        ctx.streams.emit("review_updated", updated.companyId || "", {
          issueId: updated.issueId,
          review: updated,
        });

        return { ok: true, review: updated };
      },
    );

    // -------------------------------------------------------------------------
    // Data: review_status (for UI)
    // -------------------------------------------------------------------------
    ctx.data.register(
      "review_status",
      {
        name: "Review Status",
        description: "Current review state for an issue.",
      },
      async (query: { issueId?: string }): Promise<ReviewStatusData> => {
        if (!query.issueId) return { review: null };
        const review = await getReview(ctx, query.issueId);
        return { review };
      },
    );

    // -------------------------------------------------------------------------
    // Data: review_history (for UI)
    // -------------------------------------------------------------------------
    ctx.data.register(
      "review_history",
      {
        name: "Review History",
        description: "Action log for an issue's review.",
      },
      async (query: { issueId?: string }): Promise<ReviewHistoryData> => {
        if (!query.issueId) return { actions: [] };
        const review = await getReview(ctx, query.issueId);
        return { actions: review?.actionLog ?? [] };
      },
    );

    // -------------------------------------------------------------------------
    // Event: issue.created
    // -------------------------------------------------------------------------
    ctx.events.subscribe(
      "issue.created",
      {},
      async (event: IssueEvent) => {
        const issueId = event.payload?.issue?.id;
        if (!issueId) return;
        ctx.logger.info("issue.created event", { issueId });

        const existing = await getReview(ctx, issueId);
        if (!existing) {
          const review = buildNewReview({
            issueId,
            companyId: event.companyId ?? "",
            summary: `Issue created: ${event.payload?.issue?.title ?? ""}`,
            reviewerName: "System",
          });
          await putReview(ctx, review);
        }
      },
    );

    // -------------------------------------------------------------------------
    // Event: issue.updated
    // -------------------------------------------------------------------------
    ctx.events.subscribe(
      "issue.updated",
      {},
      async (event: IssueEvent) => {
        const issueId = event.payload?.issue?.id;
        if (!issueId) return;
        ctx.logger.info("issue.updated event", { issueId });

        const review = await getReview(ctx, issueId);
        if (review && review.status === "pending_review") {
          const updated = updateReviewStatus(review, review.status, {
            action: "issue updated — review in progress",
            reviewer: "agent",
            reviewerName: "System",
          });
          await putReview(ctx, updated);
        }
      },
    );

    // -------------------------------------------------------------------------
    // Event: issue.comment_created
    // -------------------------------------------------------------------------
    ctx.events.subscribe(
      "issue.comment_created",
      {},
      async (event: CommentEvent) => {
        const issueId = event.payload?.issue?.id;
        const commentBody = event.payload?.comment?.body;
        if (!issueId || !commentBody) return;
        ctx.logger.info("issue.comment_created event", {
          issueId,
          commentLength: commentBody.length,
        });

        const review = await getReview(ctx, issueId);
        if (review) {
          const updated = updateReviewStatus(review, review.status, {
            action: "comment added",
            reviewer: "user",
            reviewerName: event.payload?.comment?.authorName ?? "User",
            comment: commentBody.slice(0, 500),
          });
          await putReview(ctx, updated);
          ctx.streams.emit("review_updated", event.companyId ?? "", {
            issueId: updated.issueId,
            review: updated,
          });
        }
      },
    );

    // -------------------------------------------------------------------------
    // Config change handler — reload config when operator updates settings
    // -------------------------------------------------------------------------
    ctx.config.onChange(async () => {
      ctx.logger.info("uos-quality-gate config changed");
    });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
