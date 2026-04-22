import type { Issue, PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import type { AgentRunFinishedEvent, IssueCreatedEvent, IssueUpdatedEvent } from "./types.js";
import {
  applyEvaluationToReview,
  buildAutoRejectComment,
  buildNewReview,
  buildSubmitComment,
  buildTelemetryEnvelope,
  evaluateQuality,
  mapTargetStatus,
} from "./helpers.js";
import { emitObservability, getConfig, getIssueSnapshot, getReview, persistReviewArtifacts, putReview } from "./shared.js";

async function postIssueComment(ctx: PluginContext, issueId: string, companyId: string, body: string): Promise<void> {
  try {
    await ctx.issues.createComment(issueId, body, companyId);
  } catch (error) {
    ctx.logger.warn("quality_gate.events: failed to post comment", { issueId, error: String(error) });
  }
}

async function handleAgentRunFinished(event: PluginEvent, ctx: PluginContext): Promise<void> {
  const runId = event.entityId ?? "";
  const companyId = event.companyId ?? "";
  const payload = event.payload as AgentRunFinishedEvent;

  if (!runId || !companyId || payload.status === "failed") {
    return;
  }

  let issueId = "";
  try {
    const issues = await ctx.issues.list({ companyId, limit: 50 });
    const matched = issues.find((issue) => {
      const record = issue as unknown as { executionRunId?: string; checkoutRunId?: string };
      return record.executionRunId === runId || record.checkoutRunId === runId;
    });
    issueId = matched?.id ?? "";
  } catch (error) {
    ctx.logger.warn("agent.run.finished: failed to list issues", { error: String(error) });
  }

  if (!issueId) return;

  try {
    const config = await getConfig(ctx);
    const { issueData } = await getIssueSnapshot(ctx, issueId, companyId);
    const evaluation = evaluateQuality(payload.qualityScore, payload.blockApproval ?? false, config, issueData);
    const existingReview = await getReview(ctx, issueId);

    const review = existingReview
      ? applyEvaluationToReview(existingReview, {
          summary: payload.summary,
          evaluation,
          reviewerName: "Agent",
          agentId: payload.agentId,
          issueData,
          blockApproval: payload.blockApproval,
          trigger: {
            source: "agent_run_finished",
            actorLabel: payload.agentId || "Agent",
            agentId: payload.agentId,
            runId,
            summary: payload.summary,
            createdAt: new Date().toISOString(),
          },
        })
      : buildNewReview({
          issueId,
          companyId,
          summary: payload.summary,
          qualityScore: payload.qualityScore,
          blockApproval: payload.blockApproval,
          reviewerName: "Agent",
          agentId: payload.agentId,
          issueData,
          evaluation,
          trigger: {
            source: "agent_run_finished",
            actorLabel: payload.agentId || "Agent",
            agentId: payload.agentId,
            runId,
            summary: payload.summary,
            createdAt: new Date().toISOString(),
          },
        });

    await putReview(ctx, review);
    await persistReviewArtifacts(ctx, review);
    await postIssueComment(
      ctx,
      issueId,
      companyId,
      evaluation.autoRejected ? buildAutoRejectComment(review.decisionScore, config.autoRejectBelow) : buildSubmitComment(review),
    );

    const targetStatus = mapTargetStatus(review.category) as Issue["status"] | null;
    if (targetStatus) {
      try {
        await ctx.issues.update(issueId, { status: targetStatus }, companyId);
      } catch (error) {
        ctx.logger.warn("agent.run.finished: failed to update issue status", { issueId, error: String(error) });
      }
    }

    await emitObservability(ctx, "auto_evaluated", review, buildTelemetryEnvelope(review, "auto_evaluated"));
    if (!existingReview) ctx.streams.emit("quality_gate.review_created", { review });
    ctx.streams.emit("quality_gate.review_updated", { review });

    if (evaluation.autoRejected) {
      ctx.streams.emit("quality_gate.threshold_breached", { review, score: review.decisionScore, reason: "auto_rejected" });
    } else if (evaluation.blockThresholdBreached || evaluation.category === "none") {
      ctx.streams.emit("quality_gate.threshold_breached", { review, score: review.decisionScore, reason: "block_threshold" });
    }
  } catch (error) {
    ctx.logger.warn("agent.run.finished: quality gate failed", { issueId, error: String(error) });
  }
}

async function handleAgentRunFailed(event: PluginEvent, ctx: PluginContext): Promise<void> {
  ctx.logger.info("agent.run.failed observed", {
    runId: event.entityId,
    companyId: event.companyId,
    payload: event.payload,
  });
}

async function handleIssueCreated(event: PluginEvent, ctx: PluginContext): Promise<void> {
  const payload = event.payload as IssueCreatedEvent;
  ctx.logger.info("issue.created observed", {
    companyId: event.companyId,
    issueId: payload.issue.id,
    status: payload.issue.status,
  });
}

async function handleIssueUpdated(event: PluginEvent, ctx: PluginContext): Promise<void> {
  const payload = event.payload as IssueUpdatedEvent;
  const issue = payload?.issue;
  ctx.logger.info("issue.updated observed", {
    companyId: event.companyId,
    issueId: issue?.id ?? event.entityId ?? null,
    status: issue?.status ?? null,
    previousStatus: payload.previousStatus,
  });
}

export function setupEvents(ctx: PluginContext): void {
  ctx.events.on("agent.run.finished", (event) => handleAgentRunFinished(event, ctx));
  ctx.events.on("agent.run.failed", (event) => handleAgentRunFailed(event, ctx));
  ctx.events.on("issue.created", (event) => handleIssueCreated(event, ctx));
  ctx.events.on("issue.updated", (event) => handleIssueUpdated(event, ctx));
}
