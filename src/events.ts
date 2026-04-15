/**
 * Event subscriptions for uos-quality-gate.
 * Each handler is registered in ctx.events by setupEvents().
 */
import type { PluginContext, PluginEvent, Issue } from "@paperclipai/plugin-sdk";
import type {
  AgentRunFinishedEvent,
  DeliverableReview,
  IssueCreatedEvent,
  IssueUpdatedEvent,
  ReviewStatus,
} from "./types.js";
import {
  buildNewReview,
  buildSubmitComment,
  evaluateQuality,
  mapTargetStatus,
  updateReviewStatus,
} from "./helpers.js";
import { getConfig, getReview, putReview } from "./shared.js";

/**
 * agent.run.finished — auto-evaluate after agent run completes.
 * Runs quality evaluation and creates/updates review automatically.
 * Does NOT auto-reject or auto-approve — always sets in_review or needs_human_review.
 */
async function handleAgentRunFinished(event: PluginEvent, ctx: PluginContext): Promise<void> {
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

  // Extract issue metadata for custom checks evaluation
  let issueData: { labels?: string[]; title?: string; assignee?: string } | undefined;
  if (issueId) {
    try {
      const issue = await ctx.issues.get(issueId, companyId);
      if (issue) {
        issueData = {
          labels: (issue as unknown as { labels?: string[] }).labels,
          title: issue.title,
          assignee: (issue as unknown as { assignee?: string }).assignee,
        };
      }
    } catch {
      // issue may have been deleted — custom checks silently skipped
    }
  }

  const evaluation = evaluateQuality(qualityScore, blockApproval ?? false, cfg, issueData);

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
      agentId,
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
}

/**
 * agent.run.failed — log failed runs; skip auto-gate since no deliverable was produced.
 */
async function handleAgentRunFailed(event: PluginEvent, ctx: PluginContext): Promise<void> {
  const runId = event.entityId ?? "";
  const companyId = event.companyId ?? "";
  ctx.logger.info("agent.run.failed observed", {
    runId,
    companyId,
    event: event.payload,
  });
}

/**
 * issue.created — observe new issues being created.
 */
async function handleIssueCreated(event: PluginEvent, ctx: PluginContext): Promise<void> {
  const payload = event.payload as unknown as IssueCreatedEvent;
  const issue = payload.issue;
  ctx.logger.info("issue.created observed", {
    issueId: issue.id,
    status: issue.status,
    companyId: event.companyId,
  });
}

/**
 * issue.updated — log status changes for audit trail.
 * Review state is updated reactively via quality_gate.submit / approve / reject.
 */
async function handleIssueUpdated(event: PluginEvent, ctx: PluginContext): Promise<void> {
  const payload = event.payload as unknown as IssueUpdatedEvent;
  const { issue } = payload;
  ctx.logger.info("issue.updated observed", {
    issueId: issue.id,
    status: issue.status,
    previousStatus: payload.previousStatus,
    companyId: event.companyId,
  });
}

/**
 * Register all quality_gate event subscriptions on the plugin context.
 */
export function setupEvents(ctx: PluginContext): void {
  ctx.events.on("agent.run.finished", (event) => handleAgentRunFinished(event, ctx));
  ctx.events.on("agent.run.failed", (event) => handleAgentRunFailed(event, ctx));
  ctx.events.on("issue.created", (event) => handleIssueCreated(event, ctx));
  ctx.events.on("issue.updated", (event) => handleIssueUpdated(event, ctx));
}
