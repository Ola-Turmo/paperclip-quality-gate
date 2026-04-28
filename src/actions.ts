import type { Issue, PluginContext } from "@paperclipai/plugin-sdk";
import type {
  ActionResult,
  ApproveHoldParams,
  ApproveParams,
  AssignParams,
  BulkApproveParams,
  BulkRejectParams,
  DeliverableReview,
  EscalateParams,
  GenerateNextStepParams,
  RejectParams,
  ReturnToAgentParams,
  SubmitForReviewParams,
} from "./types.js";
import {
  applyEvaluationToReview,
  assignReview,
  buildApproveComment,
  buildApproveHoldComment,
  buildAutoRejectComment,
  buildEscalateComment,
  buildNewReview,
  buildNextStepTemplate,
  buildRejectComment,
  buildReturnToAgentComment,
  buildSubmitComment,
  buildTelemetryEnvelope,
  evaluateQuality,
  mapTargetStatus,
  updateReviewStatus,
} from "./helpers.js";
import {
  castParams,
  emitObservability,
  getConfig,
  getIssueSnapshot,
  getReview,
  persistReviewArtifacts,
  putReview,
} from "./shared.js";

async function syncIssueStatus(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
  status: Issue["status"] | null,
): Promise<void> {
  if (!companyId || !status) return;
  try {
    await ctx.issues.update(issueId, { status }, companyId);
  } catch (error) {
    ctx.logger.warn("quality_gate: failed to update issue status", {
      issueId,
      status,
      error: String(error),
    });
  }
}

async function postIssueComment(
  ctx: PluginContext,
  review: DeliverableReview,
  body: string,
): Promise<void> {
  if (!review.companyId) return;
  try {
    await ctx.issues.createComment(review.issueId, body, review.companyId);
  } catch (error) {
    ctx.logger.warn("quality_gate: failed to post issue comment", {
      issueId: review.issueId,
      error: String(error),
    });
  }
}

async function logActivity(
  ctx: PluginContext,
  review: DeliverableReview,
  message: string,
): Promise<void> {
  if (!review.companyId) return;
  try {
    await ctx.activity.log({
      companyId: review.companyId,
      message,
      entityType: "issue",
      entityId: review.issueId,
    });
  } catch {
    // optional capability
  }
}

async function finalizeReviewUpdate(
  ctx: PluginContext,
  review: DeliverableReview,
  commentBody: string,
  issueStatus: Issue["status"] | null,
  lifecycleEvent: string,
  streamEvent?: string,
): Promise<ActionResult<DeliverableReview>> {
  await putReview(ctx, review);
  await persistReviewArtifacts(ctx, review);
  await syncIssueStatus(ctx, review.issueId, review.companyId, issueStatus);
  await postIssueComment(ctx, review, commentBody);
  await logActivity(
    ctx,
    review,
    `${lifecycleEvent} for issue ${review.issueId}`,
  );
  await emitObservability(
    ctx,
    lifecycleEvent,
    review,
    buildTelemetryEnvelope(review, lifecycleEvent),
  );
  ctx.streams.emit("quality_gate.review_updated", { review });
  if (streamEvent) {
    ctx.streams.emit(streamEvent, { review });
  }
  return { ok: true, review };
}

async function handleSubmit(
  ctx: PluginContext,
  params: Record<string, unknown>,
): Promise<ActionResult<DeliverableReview>> {
  const p = castParams<SubmitForReviewParams>(params);
  if (!p.issue_id) {
    return { ok: false, error: "issue_id is required" };
  }

  try {
    const config = await getConfig(ctx);
    const { issueData, companyId } = await getIssueSnapshot(ctx, p.issue_id);
    const evaluation = evaluateQuality(
      p.quality_score,
      p.block_approval ?? false,
      config,
      issueData,
    );
    const existingReview = await getReview(ctx, p.issue_id);

    const review = existingReview
      ? applyEvaluationToReview(existingReview, {
          summary: p.summary,
          comment: p.comment,
          evaluation,
          reviewerName: "Operator",
          issueData,
          blockApproval: p.block_approval,
          trigger: {
            source: "resubmission",
            actorLabel: "Operator",
            summary: p.summary,
            createdAt: new Date().toISOString(),
          },
        })
      : buildNewReview({
          issueId: p.issue_id,
          companyId,
          summary: p.summary,
          comment: p.comment,
          qualityScore: p.quality_score,
          blockApproval: p.block_approval,
          reviewerName: "Operator",
          issueData,
          evaluation,
          trigger: {
            source: "manual_submit",
            actorLabel: "Operator",
            summary: p.summary,
            createdAt: new Date().toISOString(),
          },
        });

    const response = await finalizeReviewUpdate(
      ctx,
      review,
      evaluation.autoRejected
        ? buildAutoRejectComment(review.decisionScore, config.autoRejectBelow)
        : buildSubmitComment(review),
      mapTargetStatus(review.category) as Issue["status"] | null,
      "submit",
      existingReview ? undefined : "quality_gate.review_created",
    );

    if (evaluation.autoRejected) {
      ctx.streams.emit("quality_gate.threshold_breached", {
        review,
        score: review.decisionScore,
        reason: "auto_rejected",
      });
    } else if (
      evaluation.blockThresholdBreached ||
      evaluation.category === "none"
    ) {
      ctx.streams.emit("quality_gate.threshold_breached", {
        review,
        score: review.decisionScore,
        reason: "block_threshold",
      });
    }

    return response;
  } catch (error) {
    ctx.logger.warn("quality_gate.submit failed", { error: String(error) });
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function handleApproveHold(
  ctx: PluginContext,
  params: Record<string, unknown>,
): Promise<ActionResult<DeliverableReview>> {
  const p = castParams<ApproveHoldParams>(params);
  if (!p.issue_id) return { ok: false, error: "issue_id is required" };

  const review = await getReview(ctx, p.issue_id);
  if (!review) return { ok: false, error: "No review found for this issue" };

  const updated = updateReviewStatus(
    review,
    "approved",
    {
      action: "approved_hold",
      reviewer: "user",
      reviewerName: "Reviewer",
      comment: p.comment,
    },
    {
      releaseDecision: {
        approvalState: "approved_hold",
        approvedBy: "Reviewer",
      },
    },
  );
  updated.nextStepTemplate = buildNextStepTemplate(updated, "release");

  return finalizeReviewUpdate(
    ctx,
    updated,
    buildApproveHoldComment(p.comment),
    "in_review",
    "approve_hold",
  );
}

async function handleApprove(
  ctx: PluginContext,
  params: Record<string, unknown>,
): Promise<ActionResult<DeliverableReview>> {
  const p = castParams<ApproveParams>(params);
  if (!p.issue_id) return { ok: false, error: "issue_id is required" };

  const review = await getReview(ctx, p.issue_id);
  if (!review) return { ok: false, error: "No review found for this issue" };

  const updated = updateReviewStatus(
    review,
    "approved",
    {
      action:
        review.releaseDecision.approvalState === "approved_hold"
          ? "released"
          : "approved_and_released",
      reviewer: "user",
      reviewerName: "Reviewer",
      comment: p.comment,
    },
    {
      releaseDecision: {
        approvalState: "released",
        approvedBy:
          review.releaseDecision.approvalState === "approved_hold"
            ? (review.releaseDecision.approvedBy ?? "Reviewer")
            : "Reviewer",
        releasedBy: "Reviewer",
        releasedAt: new Date().toISOString(),
      },
    },
  );
  updated.nextStepTemplate = buildNextStepTemplate(updated, "follow_up");

  return finalizeReviewUpdate(
    ctx,
    updated,
    buildApproveComment(p.comment),
    "done",
    "approve",
    "quality_gate.review_approved",
  );
}

async function handleReject(
  ctx: PluginContext,
  params: Record<string, unknown>,
): Promise<ActionResult<DeliverableReview>> {
  const p = castParams<RejectParams>(params);
  if (!p.issue_id) return { ok: false, error: "issue_id is required" };
  if (!p.comment?.trim())
    return { ok: false, error: "comment is required when requesting revision" };

  const review = await getReview(ctx, p.issue_id);
  if (!review) return { ok: false, error: "No review found for this issue" };

  const updated = updateReviewStatus(
    review,
    "rejected",
    {
      action: "revision_requested",
      reviewer: "user",
      reviewerName: "Reviewer",
      comment: p.comment,
    },
    {
      category: "rejected",
      releaseDecision: {
        approvalState: "rejected",
        approvedBy: review.releaseDecision.approvedBy,
      },
      handoffTask: {
        ...review.handoffTask,
        instructionMd: p.comment,
        status: "queued",
        updatedAt: new Date().toISOString(),
      },
    },
  );
  updated.nextStepTemplate = buildNextStepTemplate(updated, "revision");

  return finalizeReviewUpdate(
    ctx,
    updated,
    buildRejectComment(p.comment),
    "in_progress",
    "request_revision",
    "quality_gate.review_rejected",
  );
}

async function handleAssign(
  ctx: PluginContext,
  params: Record<string, unknown>,
): Promise<ActionResult<DeliverableReview>> {
  const p = castParams<AssignParams>(params);
  if (!p.issue_id) return { ok: false, error: "issue_id is required" };
  if (!p.assigned_to?.trim())
    return { ok: false, error: "assigned_to is required" };

  const review = await getReview(ctx, p.issue_id);
  if (!review) return { ok: false, error: "No review found for this issue" };
  const updated = assignReview(review, p.assigned_to.trim(), "Reviewer");

  return finalizeReviewUpdate(
    ctx,
    updated,
    `## 👤 Quality Gate — Reassigned\n\nAssigned reviewer: **${p.assigned_to.trim()}**`,
    null,
    "assign",
    "quality_gate.review_assigned",
  );
}

async function handleReturnToAgent(
  ctx: PluginContext,
  params: Record<string, unknown>,
): Promise<ActionResult<DeliverableReview>> {
  const p = castParams<ReturnToAgentParams>(params);
  if (!p.issue_id) return { ok: false, error: "issue_id is required" };
  if (!p.instruction?.trim())
    return { ok: false, error: "instruction is required" };

  const review = await getReview(ctx, p.issue_id);
  if (!review) return { ok: false, error: "No review found for this issue" };

  const updated = updateReviewStatus(
    review,
    "rejected",
    {
      action: "returned_to_agent",
      reviewer: "user",
      reviewerName: "Reviewer",
      comment: p.instruction,
    },
    {
      category: "rejected",
      handoffTask: {
        targetAgentId: p.target_agent_id,
        instructionMd: p.instruction,
        status: "returned_to_agent",
        updatedAt: new Date().toISOString(),
      },
      releaseDecision: {
        approvalState: "rejected",
        approvedBy: review.releaseDecision.approvedBy,
      },
    },
  );
  updated.nextStepTemplate = buildNextStepTemplate(updated, "revision");

  return finalizeReviewUpdate(
    ctx,
    updated,
    buildReturnToAgentComment(p.instruction, p.target_agent_id),
    "in_progress",
    "return_to_agent",
  );
}

async function handleEscalate(
  ctx: PluginContext,
  params: Record<string, unknown>,
): Promise<ActionResult<DeliverableReview>> {
  const p = castParams<EscalateParams>(params);
  if (!p.issue_id) return { ok: false, error: "issue_id is required" };
  if (!p.comment?.trim()) return { ok: false, error: "comment is required" };

  const review = await getReview(ctx, p.issue_id);
  if (!review) return { ok: false, error: "No review found for this issue" };

  const updated = updateReviewStatus(
    review,
    "escalated",
    {
      action: "escalated",
      reviewer: "user",
      reviewerName: "Reviewer",
      comment: p.comment,
    },
    {
      category: "escalated",
      assignedTo: p.escalate_to?.trim() || review.assignedTo,
      releaseDecision: {
        approvalState: "escalated",
        approvedBy: review.releaseDecision.approvedBy,
      },
      handoffTask: {
        ...review.handoffTask,
        instructionMd: p.comment,
        status: "escalated",
        updatedAt: new Date().toISOString(),
      },
    },
  );
  updated.nextStepTemplate = buildNextStepTemplate(updated, "follow_up");

  return finalizeReviewUpdate(
    ctx,
    updated,
    buildEscalateComment(p.comment, p.escalate_to?.trim()),
    "blocked",
    "escalate",
  );
}

async function handleGenerateNextStep(
  ctx: PluginContext,
  params: Record<string, unknown>,
): Promise<ActionResult<DeliverableReview>> {
  const p = castParams<GenerateNextStepParams>(params);
  if (!p.issue_id) return { ok: false, error: "issue_id is required" };

  const review = await getReview(ctx, p.issue_id);
  if (!review) return { ok: false, error: "No review found for this issue" };

  const template = buildNextStepTemplate(review, p.goal ?? "revision");
  const updated = updateReviewStatus(
    review,
    review.status,
    {
      action: "next_step_generated",
      reviewer: "system",
      reviewerName: "Quality Gate",
      comment: p.goal ?? "revision",
      auto: true,
    },
    {
      nextStepTemplate: template,
    },
  );

  const result = await finalizeReviewUpdate(
    ctx,
    updated,
    "## 🧭 Quality Gate — Next Step Updated\n\nA fresh next-step template was generated and stored on the issue.",
    null,
    "generate_next_step",
  );
  result.template = template;
  return result;
}

interface BulkResultItem {
  issueId: string;
  ok: boolean;
  error?: string;
}

async function processBulk(
  ctx: PluginContext,
  issueIds: string[],
  fn: (
    ctx: PluginContext,
    params: Record<string, unknown>,
  ) => Promise<ActionResult<DeliverableReview>>,
  extraParams: Record<string, unknown> = {},
): Promise<{ succeeded: string[]; failed: BulkResultItem[] }> {
  const succeeded: string[] = [];
  const failed: BulkResultItem[] = [];
  const concurrency = 5;

  for (let index = 0; index < issueIds.length; index += concurrency) {
    const batch = issueIds.slice(index, index + concurrency);
    const results = await Promise.all(
      batch.map(async (issueId) => ({
        issueId,
        result: await fn(ctx, { issue_id: issueId, ...extraParams }),
      })),
    );

    for (const { issueId, result } of results) {
      if (result.ok) succeeded.push(issueId);
      else
        failed.push({
          issueId,
          ok: false,
          error: result.error ?? "Unknown error",
        });
    }
  }

  return { succeeded, failed };
}

async function handleBulkApprove(
  ctx: PluginContext,
  params: Record<string, unknown>,
): Promise<ActionResult<{ succeeded: string[]; failed: BulkResultItem[] }>> {
  const p = castParams<BulkApproveParams>(params);
  if (!Array.isArray(p.issue_ids) || p.issue_ids.length === 0) {
    return { ok: false, error: "issue_ids is required" };
  }
  const result = await processBulk(ctx, p.issue_ids, handleApprove, {
    comment: p.comment,
  });
  return {
    ok: true,
    review: result,
    message: `Released ${result.succeeded.length} review(s).`,
  };
}

async function handleBulkReject(
  ctx: PluginContext,
  params: Record<string, unknown>,
): Promise<ActionResult<{ succeeded: string[]; failed: BulkResultItem[] }>> {
  const p = castParams<BulkRejectParams>(params);
  if (!Array.isArray(p.issue_ids) || p.issue_ids.length === 0) {
    return { ok: false, error: "issue_ids is required" };
  }
  if (!p.comment?.trim()) {
    return { ok: false, error: "comment is required" };
  }
  const result = await processBulk(ctx, p.issue_ids, handleReject, {
    comment: p.comment,
  });
  return {
    ok: true,
    review: result,
    message: `Requested revisions for ${result.succeeded.length} review(s).`,
  };
}

export function setupActions(ctx: PluginContext): void {
  ctx.actions.register("quality_gate.submit", (params) =>
    handleSubmit(ctx, params),
  );
  ctx.actions.register("quality_gate.approve", (params) =>
    handleApprove(ctx, params),
  );
  ctx.actions.register("quality_gate.approve_hold", (params) =>
    handleApproveHold(ctx, params),
  );
  ctx.actions.register("quality_gate.reject", (params) =>
    handleReject(ctx, params),
  );
  ctx.actions.register("quality_gate.assign", (params) =>
    handleAssign(ctx, params),
  );
  ctx.actions.register("quality_gate.return_to_agent", (params) =>
    handleReturnToAgent(ctx, params),
  );
  ctx.actions.register("quality_gate.escalate", (params) =>
    handleEscalate(ctx, params),
  );
  ctx.actions.register("quality_gate.generate_next_step", (params) =>
    handleGenerateNextStep(ctx, params),
  );
  ctx.actions.register("quality_gate.bulk_approve", (params) =>
    handleBulkApprove(ctx, params),
  );
  ctx.actions.register("quality_gate.bulk_reject", (params) =>
    handleBulkReject(ctx, params),
  );
}
