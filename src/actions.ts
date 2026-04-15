/**
 * Action registrations for uos-quality-gate.
 * Each function is registered in ctx.actions by setupActions().
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { Issue } from "@paperclipai/plugin-sdk";
import type {
  ActionResult,
  ApproveParams,
  DeliverableReview,
  RejectParams,
  ReviewStatus,
  SubmitForReviewParams,
} from "./types.js";
import {
  buildApproveComment,
  buildRejectComment,
  buildSubmitComment,
  buildNewReview,
  evaluateQuality,
  mapTargetStatus,
  updateReviewStatus,
} from "./helpers.js";
import { castParams, getConfig, getReview, putReview } from "./shared.js";

/**
 * quality_gate.submit — evaluate a deliverable and create/update a review.
 * Idempotent: submitting the same issue again updates the existing review.
 */
async function handleSubmit(
  ctx: PluginContext,
  params: Record<string, unknown>,
): Promise<ActionResult> {
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
}

/**
 * quality_gate.approve — approve a deliverable (human reviewer).
 * Idempotent: double-approve is a no-op, not an error.
 */
async function handleApprove(
  ctx: PluginContext,
  params: Record<string, unknown>,
): Promise<ActionResult> {
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
}

/**
 * quality_gate.reject — reject a deliverable (human reviewer).
 * Idempotent: double-reject is a no-op.
 */
async function handleReject(
  ctx: PluginContext,
  params: Record<string, unknown>,
): Promise<ActionResult> {
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
}

/**
 * Register all quality_gate actions on the plugin context.
 */
export function setupActions(ctx: PluginContext): void {
  ctx.actions.register("quality_gate.submit", (params) => handleSubmit(ctx, params));
  ctx.actions.register("quality_gate.approve", (params) => handleApprove(ctx, params));
  ctx.actions.register("quality_gate.reject", (params) => handleReject(ctx, params));
}
