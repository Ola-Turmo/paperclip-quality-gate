import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
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
  getReview,
  putReview,
  updateReviewStatus,
} from "./helpers.js";

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
          "Submit a deliverable for quality review. Evaluates the deliverable " +
          "and blocks approval if quality is insufficient or the agent flagged a " +
          "known limitation. Call after completing any deliverable to open it for " +
          "human review.",
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
                "Self-assessed quality score (0–10). " +
                "Score below 7 may block automatic approval.",
            },
            block_approval: {
              type: "boolean",
              description:
                "Set to true when there is a known limitation or open question " +
                "that should prevent approval pending human review.",
            },
          },
          additionalProperties: false,
        },
      },
      async (
        params: QualityGateReviewInput,
        _runCtx,
      ): Promise<QualityGateReviewOutput> => {
        const { issue_id, deliverable_summary, quality_score, block_approval } =
          params;

        ctx.logger.info("quality_gate_review called", { issueId: issue_id });

        const existing = await getReview(ctx, issue_id);

        // If already approved or rejected, just return current state
        if (existing && existing.status !== "pending_review") {
          return {
            success: true,
            review: existing,
            message: `Deliverable is already ${existing.status}.`,
          };
        }

        // Evaluate quality
        const check = evaluateDeliverable({
          deliverableSummary: deliverable_summary,
          qualityScore: quality_score,
          blockApproval: block_approval,
        });

        const reviewerName = (_runCtx as Record<string, unknown>)?.agentId
          ? String((_runCtx as Record<string, unknown>).agentId)
          : "Agent";

        const review = existing
          ? updateReviewStatus(existing, "pending_review", {
              action: "re-submitted for review",
              reviewer: "agent",
              reviewerName,
              comment: deliverable_summary,
              qualityScore: quality_score,
            })
          : buildNewReview({
              issueId: issue_id,
              summary: deliverable_summary,
              qualityScore: quality_score,
              blockApproval: block_approval,
              reviewerName,
            });

        await putReview(ctx, review);

        // Notify UI listeners
        ctx.streams.emit("review_updated", {
          issueId: review.issueId,
          review,
        });

        return {
          success: true,
          review,
          message: check.summary,
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
      async (params: SubmitForReviewParams) => {
        const review = buildNewReview({
          issueId: params.issue_id,
          summary: params.summary,
          qualityScore: params.quality_score,
          blockApproval: params.block_approval,
          reviewerName: "User",
        });
        await putReview(ctx, review);
        ctx.streams.emit("review_updated", {
          issueId: review.issueId,
          review,
        });
        return { ok: true, review };
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
            comment: {
              type: "string",
              description: "Optional review note.",
            },
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
        });
        await putReview(ctx, updated);
        ctx.streams.emit("review_updated", {
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
              description:
                "Required reason for rejection, including what must be revised.",
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
        });
        await putReview(ctx, updated);
        ctx.streams.emit("review_updated", {
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
      async (query: {
        issueId?: string;
      }): Promise<ReviewHistoryData> => {
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
      async (event: IssueCreatedEvent) => {
        const issueId = (event as IssueCreatedEvent).payload?.issue?.id;
        if (!issueId) return;
        ctx.logger.info("issue.created event", { issueId });

        const existing = await getReview(ctx, issueId);
        if (!existing) {
          const review = buildNewReview({
            issueId,
            summary: "Issue created",
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
      async (event: IssueUpdatedEvent) => {
        const issueId = (event as IssueUpdatedEvent).payload?.issue?.id;
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
      async (event: CommentCreatedEvent) => {
        const issueId = (event as CommentCreatedEvent).payload?.issue?.id;
        const commentBody = (event as CommentCreatedEvent).payload?.comment
          ?.body;
        if (!issueId || !commentBody) return;
        ctx.logger.info("issue.comment_created event", {
          issueId,
          commentLength: commentBody.length,
        });

        const review = await getReview(ctx, issueId);
        if (review) {
          const authorName = (event as CommentCreatedEvent).payload?.comment
            ?.authorName ?? "User";
          const updated = updateReviewStatus(review, review.status, {
            action: "comment added",
            reviewer: "user",
            reviewerName: authorName,
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
runWorker(plugin, import.meta.url);
