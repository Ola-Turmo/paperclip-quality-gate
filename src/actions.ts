/**
 * Action registrations for uos-quality-gate.
 * Each function is registered in ctx.actions by setupActions().
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { Issue } from "@paperclipai/plugin-sdk";
import type {
  ActionResult,
  ApproveParams,
  AssignParams,
  BulkApproveParams,
  BulkRejectParams,
  DeliverableReview,
  RejectParams,
  ReviewStatus,
  SubmitForReviewParams,
} from "./types.js";
import {
  assignReview,
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
 * quality_gate.assign — reassign a review to a different reviewer.
 * Idempotent: reassigning to the same person is a no-op.
 */
async function handleAssign(
  ctx: PluginContext,
  params: Record<string, unknown>,
): Promise<ActionResult> {
  const p = castParams<AssignParams>(params);
  const issueId = p.issue_id;
  if (!issueId) {
    return { ok: false, error: "issue_id is required" } as ActionResult;
  }
  if (!p.assigned_to) {
    return { ok: false, error: "assigned_to is required" } as ActionResult;
  }

  const review = await getReview(ctx, issueId);
  if (!review) {
    return { ok: false, error: "No review found for this issue" } as ActionResult;
  }

  if (review.assignedTo === p.assigned_to) {
    return { ok: true, review, message: "Already assigned to this reviewer" } as ActionResult<DeliverableReview>;
  }

  const updated = assignReview(review, p.assigned_to, "Reviewer");
  await putReview(ctx, updated);

  ctx.streams.emit("quality_gate.review_assigned", { review: updated });

  ctx.logger.info("quality_gate.assign: review reassigned", { issueId, assignedTo: p.assigned_to });
  return { ok: true, review: updated } as ActionResult<DeliverableReview>;
}

interface BulkResultItem {
  issueId: string;
  ok: boolean;
  error?: string;
}

async function processBulk(
  ctx: PluginContext,
  issueIds: string[],
  fn: (ctx: PluginContext, params: Record<string, unknown>) => Promise<ActionResult>,
): Promise<{ succeeded: string[]; failed: BulkResultItem[] }> {
  const succeeded: string[] = [];
  const failed: BulkResultItem[] = [];
  const CONCURRENCY = 5;
  for (let i = 0; i < issueIds.length; i += CONCURRENCY) {
    const batch = issueIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((issueId) =>
        fn(ctx, { issue_id: issueId }).then((r) => ({ issueId, r }))
      )
    );
    for (const { issueId, r } of results) {
      if (r.ok) {
        succeeded.push(issueId);
      } else {
        failed.push({ issueId, ok: false, error: r.error ?? "Unknown error" });
      }
    }
  }
  return { succeeded, failed };
}

/**
 * quality_gate.bulk_approve — approve multiple deliverables at once.
 * Processes up to 5 concurrent approvals.
 */
async function handleBulkApprove(
  ctx: PluginContext,
  params: Record<string, unknown>,
): Promise<ActionResult> {
  const p = castParams<BulkApproveParams>(params);
  if (!p.issue_ids || p.issue_ids.length === 0) {
    return { ok: false, error: "issue_ids is required and must be non-empty" } as ActionResult;
  }
  const { succeeded, failed } = await processBulk(ctx, p.issue_ids, handleApprove);
  ctx.logger.info("quality_gate.bulk_approve: processed", {
    total: p.issue_ids.length,
    succeeded: succeeded.length,
    failed: failed.length,
  });
  return {
    ok: true,
    message: `Approved ${succeeded.length}/${p.issue_ids.length}. ${failed.length} failed.`,
  } as ActionResult;
}

/**
 * quality_gate.bulk_reject — reject multiple deliverables at once.
 * Requires comment. Processes up to 5 concurrent rejections.
 */
async function handleBulkReject(
  ctx: PluginContext,
  params: Record<string, unknown>,
): Promise<ActionResult> {
  const p = castParams<BulkRejectParams>(params);
  if (!p.issue_ids || p.issue_ids.length === 0) {
    return { ok: false, error: "issue_ids is required and must be non-empty" } as ActionResult;
  }
  if (!p.comment) {
    return { ok: false, error: "comment is required for bulk reject" } as ActionResult;
  }
  const { succeeded, failed } = await processBulk(ctx, p.issue_ids, (ctx, params) =>
    handleReject(ctx, { ...params, comment: p.comment })
  );
  ctx.logger.info("quality_gate.bulk_reject: processed", {
    total: p.issue_ids.length,
    succeeded: succeeded.length,
    failed: failed.length,
  });
  return {
    ok: true,
    message: `Rejected ${succeeded.length}/${p.issue_ids.length}. ${failed.length} failed.`,
  } as ActionResult;
}

/**
 * Register all quality_gate actions on the plugin context.
 */
export function setupActions(ctx: PluginContext): void {
  ctx.actions.register("quality_gate.submit", (params) => handleSubmit(ctx, params));
  ctx.actions.register("quality_gate.approve", (params) => handleApprove(ctx, params));
  ctx.actions.register("quality_gate.reject", (params) => handleReject(ctx, params));
  ctx.actions.register("quality_gate.assign", (params) => handleAssign(ctx, params));
  ctx.actions.register("quality_gate.bulk_approve", (params) => handleBulkApprove(ctx, params));
  ctx.actions.register("quality_gate.bulk_reject", (params) => handleBulkReject(ctx, params));
}
