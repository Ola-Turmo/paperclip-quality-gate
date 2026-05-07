import type {
  Issue,
  PluginContext,
  PluginEvent,
} from "@paperclipai/plugin-sdk";
import type {
  AgentRunFinishedEvent,
  IssueCreatedEvent,
  IssueUpdatedEvent,
} from "./types.js";
import {
  applyEvaluationToReview,
  buildAutoRejectComment,
  buildNewReview,
  buildSubmitComment,
  buildTelemetryEnvelope,
  evaluateQuality,
  mapTargetStatus,
} from "./helpers.js";
import {
  emitObservability,
  getConfig,
  getIssueSnapshot,
  getReview,
  persistReviewArtifacts,
  putReview,
} from "./shared.js";
import { STATE_KEYS } from "./helpers.js";

async function postIssueComment(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
  body: string,
): Promise<void> {
  try {
    await ctx.issues.createComment(issueId, body, companyId);
  } catch (error) {
    ctx.logger.warn("quality_gate.events: failed to post comment", {
      issueId,
      error: String(error),
    });
  }
}

function getRunIndexKey(runId: string) {
  return {
    scopeKind: "run" as const,
    scopeId: runId,
    stateKey: STATE_KEYS.RUN_INDEX,
  };
}

async function findIssueIdForRun(
  ctx: PluginContext,
  runId: string,
  companyId: string,
): Promise<string | null> {
  // 1. Try the run-scoped index first (written by agent.run.started).
  try {
    const indexed = await ctx.state.get(getRunIndexKey(runId));
    if (typeof indexed === "string" && indexed) {
      return indexed;
    }
  } catch {
    // ignore
  }

  // 2. Fallback: scan recent issues for run linkage.
  // Paperclip may clear executionRunId/checkoutRunId when a run finishes,
  // so the index is the primary source. originRunId is an additional
  // fallback field that persists on some issues.
  try {
    const issues = await ctx.issues.list({ companyId, limit: 100 });
    const matched = issues.find((issue) => {
      const record = issue as unknown as {
        executionRunId?: string | null;
        checkoutRunId?: string | null;
        originRunId?: string | null;
      };
      return (
        record.executionRunId === runId ||
        record.checkoutRunId === runId ||
        record.originRunId === runId
      );
    });
    if (matched?.id) {
      return matched.id;
    }
  } catch (error) {
    ctx.logger.warn("agent.run.finished: failed to list issues", {
      error: String(error),
    });
  }

  return null;
}

async function handleAgentRunStarted(
  event: PluginEvent,
  ctx: PluginContext,
): Promise<void> {
  const runId = event.entityId ?? "";
  const companyId = event.companyId ?? "";

  if (!runId || !companyId) return;

  try {
    const issues = await ctx.issues.list({ companyId, limit: 100 });
    const matched = issues.find((issue) => {
      const record = issue as unknown as {
        executionRunId?: string | null;
        checkoutRunId?: string | null;
      };
      return record.executionRunId === runId || record.checkoutRunId === runId;
    });

    const issueId = matched?.id ?? "";
    if (issueId) {
      await ctx.state.set(getRunIndexKey(runId), issueId);
      ctx.logger.info("agent.run.started: indexed run to issue", {
        runId,
        issueId,
        companyId,
      });
    }
  } catch (error) {
    ctx.logger.warn("agent.run.started: failed to index run", {
      runId,
      error: String(error),
    });
  }
}

async function handleAgentRunFinished(
  event: PluginEvent,
  ctx: PluginContext,
): Promise<void> {
  const runId = event.entityId ?? "";
  const companyId = event.companyId ?? "";
  const payload = event.payload as AgentRunFinishedEvent;

  if (!runId || !companyId || payload.status === "failed") {
    return;
  }

  const issueId = await findIssueIdForRun(ctx, runId, companyId);
  if (!issueId) {
    ctx.logger.warn("agent.run.finished: no issue found for run", { runId });
    return;
  }

  // Clean up the run index now that we have resolved the issue.
  try {
    await ctx.state.delete(getRunIndexKey(runId));
  } catch {
    // best-effort cleanup
  }

  try {
    const config = await getConfig(ctx);
    const { issueData } = await getIssueSnapshot(ctx, issueId, companyId);

    // Defensive extraction: Paperclip may not send plugin-specific fields.
    const qualityScore =
      typeof payload.qualityScore === "number"
        ? payload.qualityScore
        : undefined;
    const blockApproval = payload.blockApproval === true;
    const summary = payload.summary;
    const agentId = payload.agentId ?? event.actorId ?? undefined;

    const evaluation = evaluateQuality(
      qualityScore,
      blockApproval,
      config,
      issueData,
    );
    const existingReview = await getReview(ctx, issueId);

    const review = existingReview
      ? applyEvaluationToReview(existingReview, {
          summary,
          evaluation,
          reviewerName: "Agent",
          agentId,
          issueData,
          blockApproval,
          trigger: {
            source: "agent_run_finished",
            actorLabel: agentId || "Agent",
            agentId,
            runId,
            summary,
            createdAt: new Date().toISOString(),
          },
        })
      : buildNewReview({
          issueId,
          companyId,
          summary,
          qualityScore,
          blockApproval,
          reviewerName: "Agent",
          agentId,
          issueData,
          evaluation,
          trigger: {
            source: "agent_run_finished",
            actorLabel: agentId || "Agent",
            agentId,
            runId,
            summary,
            createdAt: new Date().toISOString(),
          },
        });

    await putReview(ctx, review);
    await persistReviewArtifacts(ctx, review);
    await postIssueComment(
      ctx,
      issueId,
      companyId,
      evaluation.autoRejected
        ? buildAutoRejectComment(review.decisionScore, config.autoRejectBelow)
        : buildSubmitComment(review),
    );

    const targetStatus = mapTargetStatus(review.category) as
      | Issue["status"]
      | null;
    if (targetStatus) {
      try {
        await ctx.issues.update(issueId, { status: targetStatus }, companyId);
      } catch (error) {
        ctx.logger.warn("agent.run.finished: failed to update issue status", {
          issueId,
          error: String(error),
        });
      }
    }

    await emitObservability(
      ctx,
      "auto_evaluated",
      review,
      buildTelemetryEnvelope(review, "auto_evaluated"),
    );
    if (!existingReview)
      ctx.streams.emit("quality_gate.review_created", { review });
    ctx.streams.emit("quality_gate.review_updated", { review });

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
  } catch (error) {
    ctx.logger.warn("agent.run.finished: quality gate failed", {
      issueId,
      error: String(error),
    });
  }
}

async function handleAgentRunFailed(
  event: PluginEvent,
  ctx: PluginContext,
): Promise<void> {
  const runId = event.entityId ?? "";
  ctx.logger.info("agent.run.failed observed", {
    runId,
    companyId: event.companyId,
    payload: event.payload,
  });

  // Clean up any stale run index.
  if (runId) {
    try {
      await ctx.state.delete(getRunIndexKey(runId));
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Trigger sources for the quality gate review.
 * Used to understand how a review was initiated.
 */
export type ReviewTriggerSource =
  | "agent_run_finished"
  | "issue_status_change"
  | "manual_submit";

async function handleIssueCreated(
  event: PluginEvent,
  ctx: PluginContext,
): Promise<void> {
  const payload = event.payload as IssueCreatedEvent;
  ctx.logger.info("issue.created observed", {
    companyId: event.companyId,
    issueId: payload.issue.id,
    status: payload.issue.status,
  });
}

async function handleIssueUpdated(
  event: PluginEvent,
  ctx: PluginContext,
): Promise<void> {
  const payload = event.payload as IssueUpdatedEvent;
  const issue = payload?.issue;
  const newStatus = issue?.status ?? null;
  const previousStatus = payload.previousStatus ?? null;

  ctx.logger.info("issue.updated observed", {
    companyId: event.companyId,
    issueId: issue?.id ?? event.entityId ?? null,
    status: newStatus,
    previousStatus,
  });

  // Auto-create a review when an issue is marked done without an agent run.
  // The agent.run.finished handler covers automated completions;
  // this handler catches manual / external completions.
  const DONE_STATUSES = new Set(["done", "completed", "approved"]);
  if (
    !newStatus ||
    !DONE_STATUSES.has(newStatus) ||
    previousStatus === newStatus
  ) {
    return;
  }

  const issueId = issue?.id ?? event.entityId ?? "";
  const companyId = event.companyId ?? "";

  if (!issueId || !companyId) return;

  // Only handle issues that transitioned *to* a done state from a non-done state.
  // If it was already done, this is not a completion transition.
  if (previousStatus && DONE_STATUSES.has(previousStatus)) {
    ctx.logger.info("issue.updated: skipping — already in a done state", {
      issueId,
      previousStatus,
      newStatus,
    });
    return;
  }

  try {
    const existingReview = await getReview(ctx, issueId);
    if (existingReview) {
      ctx.logger.info(
        "issue.updated: review already exists for issue, skipping",
        { issueId, reviewId: existingReview.id },
      );
      return;
    }

    const config = await getConfig(ctx);
    const { issueData } = await getIssueSnapshot(ctx, issueId, companyId);

    // Evaluate with a null qualityScore since there was no agent run
    const qualityScore: number | undefined = undefined;
    const evaluation = evaluateQuality(qualityScore, false, config, issueData);

    const review = buildNewReview({
      issueId,
      companyId,
      summary: issueData.description ?? issueData.title,
      qualityScore,
      blockApproval: false,
      reviewerName: "System",
      agentId: undefined,
      issueData,
      evaluation,
      trigger: {
        source: "issue_status_change",
        actorLabel: "Manual completion",
        agentId: undefined,
        runId: undefined,
        summary: `Issue marked ${newStatus} manually — no agent run recorded`,
        createdAt: new Date().toISOString(),
      },
    });

    await putReview(ctx, review);
    await persistReviewArtifacts(ctx, review);
    await postIssueComment(ctx, issueId, companyId, buildSubmitComment(review));

    ctx.streams.emit("quality_gate.review_created", { review });
    ctx.logger.info(
      "issue.updated: auto-created review for manual completion",
      {
        issueId,
        reviewId: review.id,
        previousStatus,
        newStatus,
      },
    );
  } catch (error) {
    ctx.logger.warn("issue.updated: failed to auto-create review", {
      issueId,
      error: String(error),
    });
  }
}

export function setupEvents(ctx: PluginContext): void {
  ctx.events.on("agent.run.started", (event) =>
    handleAgentRunStarted(event, ctx),
  );
  ctx.events.on("agent.run.finished", (event) =>
    handleAgentRunFinished(event, ctx),
  );
  ctx.events.on("agent.run.failed", (event) =>
    handleAgentRunFailed(event, ctx),
  );
  ctx.events.on("issue.created", (event) => handleIssueCreated(event, ctx));
  ctx.events.on("issue.updated", (event) => handleIssueUpdated(event, ctx));
}
