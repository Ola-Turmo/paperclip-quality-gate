import type { PluginContext, PluginEvent, PluginEventType } from "@paperclipai/plugin-sdk";
import type {
  ActionResult,
  ApproveParams,
  IssueStatus,
  QualityGateReviewInput,
  RejectParams,
  ReviewHistoryData,
  ReviewStatusData,
  SubmitForReviewParams,
} from "./types.js";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
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
  comment?: {
    id?: string;
    body?: string;
    authorUserId?: string | null;
    authorAgentId?: string | null;
  };
}

interface AgentRunFinishedPayload {
  runId?: string;
  agentId?: string;
  issueId?: string;
  projectId?: string;
  companyId?: string;
  outputUrl?: string;
  status?: string;
  [key: string]: unknown;
}

type IssueEvent = PluginEvent<IssuePayload>;
type CommentEvent = PluginEvent<CommentPayload>;
type AgentRunFinishedEvent = PluginEvent<AgentRunFinishedPayload>;

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
function getTargetIssueStatus(review: {
  status: string;
  blockThresholdBreached?: boolean;
  autoRejected?: boolean;
}): string {
  if (review.blockThresholdBreached) return "blocked";
  if (review.autoRejected) return "in_progress";
  switch (review.status) {
    case "approved":
      return "done";
    case "rejected":
      return "in_progress";
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
        displayName: "Quality Gate Review",
        description:
          "Submit a deliverable for quality review. Evaluates quality across " +
          "completeness, correctness, clarity, test coverage, and documentation. " +
          "Auto-rejects scores below the configured threshold. " +
          "Flags for human review if block_approval=true or score is below minimum.",
        parametersSchema: {
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
      async (params: unknown): Promise<{ content?: string; data?: unknown; error?: string }> => {
        const p = params as QualityGateReviewInput;
        const { issue_id, deliverable_summary, quality_score, block_approval, self_assessment } = p;

        ctx.logger.info("quality_gate_review called", { issueId: issue_id });

        const cfg = await getConfig(ctx);
        const existing = await getReview(ctx, issue_id);

        if (existing && existing.status !== "pending_review") {
          return {
            content: `Deliverable is already ${existing.status}.`,
            data: {
              success: true,
              review: existing,
              evaluation: {
                overallScore: existing.qualityScore ?? 0,
                passed: existing.status === "approved",
                autoRejected: false,
                blockThresholdBreached: false,
                checks: existing.qualityChecks ?? [],
                blockers: [],
                summary: `Already ${existing.status}.`,
              },
            },
          };
        }

        const evaluation = evaluateDeliverable({
          qualityScore: quality_score,
          blockApproval: block_approval,
          selfAssessment: self_assessment,
          config: cfg,
        });

        const review = existing
          ? updateReviewStatus(existing, "pending_review", {
              action: "re-submitted for review",
              reviewer: "agent",
              reviewerName: "Agent",
              comment: deliverable_summary,
              qualityScore: evaluation.overallScore,
              auto: false,
            })
          : buildNewReview({
              issueId: issue_id,
              companyId: "",
              summary: deliverable_summary,
              qualityScore: evaluation.overallScore,
              blockApproval: block_approval ?? false,
              reviewerName: "Agent",
              qualityChecks: evaluation.checks,
              evaluationSummary: evaluation.summary,
            });

        await putReview(ctx, review);

        if (review.companyId) {
          try {
            await ctx.issues.createComment(issue_id, buildSubmitComment({
                qualityScore: evaluation.overallScore,
                evaluationSummary: evaluation.summary,
                blockApproval: block_approval ?? false,
                qualityChecks: evaluation.checks,
              }), review.companyId);
          } catch (err) {
            ctx.logger.warn("Failed to post submit comment", { error: String(err) });
          }
        }

        // Set issue to in_review
        if (review.companyId) {
          try {
            await ctx.issues.update(issue_id, { status: "in_review" }, review.companyId);
          } catch (err) {
            ctx.logger.warn("Failed to update issue status to in_review", { error: String(err) });
          }
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

          if (autoReview.companyId) {
            try {
              await ctx.issues.update(issue_id, { status: "in_progress" }, autoReview.companyId);
              await ctx.issues.createComment(issue_id, buildRejectComment(evaluation.summary), autoReview.companyId);
            } catch (err) {
              ctx.logger.warn("Failed auto-reject update", { error: String(err) });
            }
          }

          ctx.streams.emit("review_updated", {
            issueId: autoReview.issueId,
            review: autoReview,
          });

          return { content: evaluation.summary, data: { success: true, review: autoReview, evaluation } };
        }

        // blockThresholdBreached → set issue to blocked
        if (evaluation.blockThresholdBreached) {
          const blockedReview = updateReviewStatus(review, "pending_review", {
            action: `blocked — score ${evaluation.overallScore} below block threshold (${cfg.blockThreshold})`,
            reviewer: "agent",
            reviewerName: "System",
            comment: evaluation.summary,
            qualityScore: evaluation.overallScore,
            auto: true,
          });
          blockedReview.autoRejected = false;
          await putReview(ctx, blockedReview);

          if (blockedReview.companyId) {
            try {
              await ctx.issues.update(issue_id, { status: "blocked" }, blockedReview.companyId);
            } catch (err) {
              ctx.logger.warn("Failed to set issue to blocked", { error: String(err) });
            }
          }

          ctx.streams.emit("review_updated", {
            issueId: blockedReview.issueId,
            review: blockedReview,
          });

          return { content: evaluation.summary, data: { success: true, review: blockedReview, evaluation } };
        }

        ctx.streams.emit("review_updated", {
          issueId: review.issueId,
          review,
        });

        return { content: evaluation.summary, data: { success: true, review, evaluation } };
      },
    );

    // -------------------------------------------------------------------------
    // Action: submit_for_review
    // -------------------------------------------------------------------------
    ctx.actions.register(
      "submit_for_review",
      async (params: Record<string, unknown>): Promise<{ ok: boolean; review?: unknown; evaluation?: unknown; error?: string }> => {
        const p = params as unknown as SubmitForReviewParams;
        const cfg = await getConfig(ctx);
        const issueId = p.issue_id as string;

        let companyId = "";
        try {
          const issue = await ctx.issues.get(issueId, "");
          if (issue) companyId = issue.companyId ?? "";
        } catch {
          // fallback: use empty string
        }

        // Run full quality evaluation to determine correct status
        const evaluation = evaluateDeliverable({
          qualityScore: p.quality_score as number | undefined,
          blockApproval: p.block_approval ?? false,
          config: cfg,
        });

        let review = buildNewReview({
          issueId,
          companyId,
          summary: p.summary as string | undefined,
          qualityScore: evaluation.overallScore,
          blockApproval: p.block_approval ?? false,
          reviewerName: "User",
          qualityChecks: evaluation.checks,
          evaluationSummary: evaluation.summary,
        });

        // Determine target issue status based on evaluation outcome
        let targetStatus = "in_review";
        if (evaluation.autoRejected) {
          // Score below autoRejectBelow — set back to in_progress (agent should fix)
          review = updateReviewStatus(review, "rejected", {
            action: `auto-rejected (score ${evaluation.overallScore} < ${cfg.autoRejectBelow})`,
            reviewer: "agent",
            reviewerName: "System",
            comment: evaluation.summary,
            qualityScore: evaluation.overallScore,
            auto: true,
          });
          targetStatus = "in_progress";
        } else if (evaluation.blockThresholdBreached) {
          // Score between autoRejectBelow and blockThreshold — blocked for human review
          targetStatus = "blocked";
        } else if (evaluation.passed) {
          // Score meets minimum — set to in_review for human approval
          targetStatus = "in_review";
        } else {
          // Below minQualityScore but above blockThreshold — in_review for human review
          targetStatus = "in_review";
        }

        await putReview(ctx, review);

        if (companyId) {
          try {
            await ctx.issues.update(issueId, { status: targetStatus as IssueStatus }, companyId);
            await ctx.issues.createComment(
              issueId,
              buildSubmitComment({
                qualityScore: evaluation.overallScore,
                evaluationSummary: evaluation.summary,
                blockApproval: p.block_approval ?? false,
                qualityChecks: evaluation.checks,
              }),
              companyId,
            );
          } catch (err) {
            ctx.logger.warn("submit_for_review: failed to update issue", { error: String(err) });
          }
        }

        ctx.streams.emit("review_updated", { issueId: review.issueId, review });

        return { ok: true, review, evaluation };
      },
    );

    // -------------------------------------------------------------------------
    // Action: approve_deliverable
    // -------------------------------------------------------------------------
    ctx.actions.register(
      "approve_deliverable",
      async (params: Record<string, unknown>): Promise<ActionResult> => {
        const p = params as unknown as ApproveParams;
        const review = await getReview(ctx, p.issue_id);
        if (!review) {
          return { ok: false, error: "No review found for this issue." };
        }

        // Idempotency: already approved is a no-op, not an error
        if (review.status === "approved") {
          return { ok: true, review, message: "Already approved." };
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
            await ctx.issues.update(p.issue_id, { status: "done" }, updated.companyId);
            await ctx.issues.createComment(p.issue_id, buildApproveComment(p.comment), updated.companyId);
          } catch (err) {
            ctx.logger.warn("approve_deliverable: failed to update issue", { error: String(err) });
          }
        }

        ctx.streams.emit("review_updated", { issueId: updated.issueId, review: updated });

        return { ok: true, review: updated };
      },
    );

    // -------------------------------------------------------------------------
    // Action: reject_deliverable
    // -------------------------------------------------------------------------
    ctx.actions.register(
      "reject_deliverable",
      async (params: Record<string, unknown>): Promise<ActionResult> => {
        const p = params as unknown as RejectParams;
        const review = await getReview(ctx, p.issue_id);
        if (!review) {
          return { ok: false, error: "No review found for this issue." };
        }

        // Idempotency: already rejected → no-op (don't re-comment or reset status)
        if (review.status === "rejected") {
          return { ok: true, review, message: "Already rejected." };
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
            await ctx.issues.update(p.issue_id, { status: "in_progress" }, updated.companyId);
            await ctx.issues.createComment(p.issue_id, buildRejectComment(p.comment), updated.companyId);
          } catch (err) {
            ctx.logger.warn("reject_deliverable: failed to update issue", { error: String(err) });
          }
        }

        ctx.streams.emit("review_updated", { issueId: updated.issueId, review: updated });

        return { ok: true, review: updated };
      },
    );

    // -------------------------------------------------------------------------
    // Data: review_status (for UI)
    // -------------------------------------------------------------------------
    ctx.data.register(
      "review_status",
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
      async (query: { issueId?: string }): Promise<ReviewHistoryData> => {
        if (!query.issueId) return { actions: [] };
        const review = await getReview(ctx, query.issueId);
        return { actions: review?.actionLog ?? [] };
      },
    );

    // -------------------------------------------------------------------------
    // Event: agent.run.finished — auto-evaluate on agent run completion
    // -------------------------------------------------------------------------
    ctx.events.on(
      "agent.run.finished" as const,
      async (rawEvent: PluginEvent) => {
        const event = rawEvent as AgentRunFinishedEvent;
        const runId = (rawEvent as unknown as { payload?: { runId?: string } }).payload?.runId
          ?? (rawEvent as unknown as { runId?: string }).runId;
        const companyId = rawEvent.companyId ?? "";
        ctx.logger.info("agent.run.finished event", { runId, companyId });

        if (!runId || !companyId) {
          ctx.logger.warn("agent.run.finished: missing runId or companyId, skipping");
          return;
        }

        // Look up the issue by executionRunId or checkoutRunId
        let issueId: string | undefined;
        try {
          const issues = await ctx.issues.list({ companyId, limit: 50 });
          const matched = issues.find(
            (issue) =>
              issue.executionRunId === runId || issue.checkoutRunId === runId,
          );
          issueId = matched?.id;
        } catch (err) {
          ctx.logger.warn("agent.run.finished: failed to list issues", { error: String(err) });
        }

        if (!issueId) {
          ctx.logger.info("agent.run.finished: no issue found for this runId, skipping auto-gate");
          return;
        }

        const cfg = await getConfig(ctx);

        // Only auto-process if no review exists yet
        const existing = await getReview(ctx, issueId);
        if (existing) {
          ctx.logger.info("agent.run.finished: review already exists for issue", { issueId });
          return;
        }

        // Run quality evaluation with placeholder/zero scores since
        // this is an auto-trigger without agent-provided self-assessment
        const evaluation = evaluateDeliverable({
          qualityScore: undefined,
          blockApproval: false,
          config: cfg,
        });

        const review = buildNewReview({
          issueId,
          companyId,
          summary: `Agent run ${runId} completed — auto-evaluated (no deliverable summary provided)`,
          qualityScore: evaluation.overallScore,
          blockApproval: false,
          reviewerName: "System",
          qualityChecks: evaluation.checks,
          evaluationSummary: evaluation.summary,
        });

        // If blockThresholdBreached, mark as pending_review with blocked flag
        if (evaluation.blockThresholdBreached) {
          review.actionLog[review.actionLog.length - 1] = {
            ...review.actionLog[review.actionLog.length - 1],
            action: `auto-blocked — score ${evaluation.overallScore} below block threshold (${cfg.blockThreshold})`,
            auto: true,
          };
        }

        await putReview(ctx, review);

        // Post a comment on the issue
        if (companyId) {
          try {
            await ctx.issues.createComment(issueId, buildSubmitComment({
              qualityScore: evaluation.overallScore,
              evaluationSummary: evaluation.summary,
              blockApproval: false,
              qualityChecks: evaluation.checks,
            }), companyId);
          } catch (err) {
            ctx.logger.warn("agent.run.finished: failed to post comment", { error: String(err) });
          }
        }

        // Set appropriate issue status
        if (companyId) {
          try {
            const targetStatus = getTargetIssueStatus({
              status: review.status,
              blockThresholdBreached: evaluation.blockThresholdBreached,
              autoRejected: evaluation.autoRejected,
            });
            await ctx.issues.update(issueId, { status: targetStatus as "done" | "blocked" | "backlog" | "todo" | "in_progress" | "in_review" | "cancelled" }, companyId);
          } catch (err) {
            ctx.logger.warn("agent.run.finished: failed to update issue status", { error: String(err) });
          }
        }

        // Emit stream event for real-time UI refresh
        ctx.streams.emit("review_updated", { issueId: review.issueId, review });

        ctx.logger.info("agent.run.finished: auto-gate complete", {
          issueId,
          score: evaluation.overallScore,
          passed: evaluation.passed,
          blockThresholdBreached: evaluation.blockThresholdBreached,
        });
      },
    );

    // -------------------------------------------------------------------------
    // Event: issue.created
    // -------------------------------------------------------------------------
    ctx.events.on(
      "issue.created",
      async (event: PluginEvent<unknown>) => {
        const issueId = (event.payload as IssuePayload | undefined)?.issue?.id;
        if (!issueId) return;
        ctx.logger.info("issue.created event", { issueId });

        const existing = await getReview(ctx, issueId);
        if (!existing) {
          const review = buildNewReview({
            issueId,
            companyId: event.companyId ?? "",
            summary: `Issue created: ${(event.payload as unknown as IssuePayload)?.issue?.title ?? ""}`,
            reviewerName: "System",
          });
          await putReview(ctx, review);
        }
      },
    );

    // -------------------------------------------------------------------------
    // Event: issue.updated
    // -------------------------------------------------------------------------
    ctx.events.on(
      "issue.updated",
      async (event: PluginEvent<unknown>) => {
        const issueId = (event.payload as IssuePayload | undefined)?.issue?.id;
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
    ctx.events.on(
      "issue.comment.created" as PluginEventType,
      async (event: PluginEvent<unknown>) => {
        const payload = event.payload as CommentPayload | undefined;
        const issueId = payload?.issue?.id;
        const commentBody = payload?.comment?.body;
        if (!issueId || !commentBody) return;
        ctx.logger.info("issue.comment.created event", {
          issueId,
          commentLength: commentBody.length,
        });

        const review = await getReview(ctx, issueId);
        if (review) {
          const authorName = payload?.comment?.authorUserId ?? payload?.comment?.authorAgentId ?? "User";
          const updated = updateReviewStatus(review, review.status, {
            action: "comment added",
            reviewer: "user",
            reviewerName: String(authorName),
            comment: commentBody.slice(0, 500),
          });
          await putReview(ctx, updated);
          ctx.streams.emit("review_updated", {
            issueId: updated.issueId,
            review: updated,
          });
        }
      },
    );
  },
});

export default plugin;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
runWorker(plugin, (import.meta as unknown as { url: string }).url);
