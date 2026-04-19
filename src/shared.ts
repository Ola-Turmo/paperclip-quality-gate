import type { Issue, PluginContext } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG } from "./manifest.js";
import {
  STATE_KEYS,
  buildEvidenceMarkdown,
  getNextStepDocumentKey,
  buildNextStepMarkdown,
  getEvidenceDocumentKey,
} from "./helpers.js";
import type { DeliverableReview, IssueMetadata, QualityGateSettings } from "./types.js";

export function castParams<T>(params: unknown): T {
  return params as T;
}

export async function getConfig(ctx: PluginContext): Promise<QualityGateSettings> {
  const config = await ctx.config.get();
  return { ...DEFAULT_CONFIG, ...(config as Partial<QualityGateSettings>) };
}

export async function getReview(ctx: PluginContext, issueId: string): Promise<DeliverableReview | null> {
  const review = await ctx.state.get({
    scopeKind: "issue" as const,
    scopeId: issueId,
    stateKey: STATE_KEYS.REVIEWS,
  });
  return (review as DeliverableReview | null) ?? null;
}

export async function putReview(ctx: PluginContext, review: DeliverableReview): Promise<void> {
  await ctx.state.set(
    { scopeKind: "issue" as const, scopeId: review.issueId, stateKey: STATE_KEYS.REVIEWS },
    review,
  );

  const indexKey = {
    scopeKind: "company" as const,
    scopeId: review.companyId,
    stateKey: STATE_KEYS.REVIEW_IDS,
  };
  const ids = ((await ctx.state.get(indexKey)) as string[] | null) ?? [];
  const next = [review.issueId, ...ids.filter((id) => id !== review.issueId)].slice(0, 200);
  await ctx.state.set(indexKey, next);
}

export async function getIssueSnapshot(
  ctx: PluginContext,
  issueId: string,
  companyIdHint?: string,
): Promise<{ issue: Issue; companyId: string; issueData: IssueMetadata }> {
  let issue = await ctx.issues.get(issueId, companyIdHint ?? "");
  if (!issue && companyIdHint) {
    issue = await ctx.issues.get(issueId, companyIdHint);
  }
  if (!issue) {
    throw new Error("Issue not found");
  }

  return {
    issue,
    companyId: issue.companyId,
    issueData: {
      labels: (issue as unknown as { labels?: string[] }).labels,
      title: issue.title,
      assignee: (issue as unknown as { assignee?: string }).assignee,
      description: issue.description ?? undefined,
      status: issue.status ?? undefined,
    },
  };
}

export async function persistReviewArtifacts(ctx: PluginContext, review: DeliverableReview): Promise<void> {
  if (!review.companyId) return;

  try {
    await ctx.issues.documents.upsert({
      issueId: review.issueId,
      companyId: review.companyId,
      key: getEvidenceDocumentKey(),
      title: "Quality Gate Evidence Package",
      format: "markdown",
      changeSummary: "Update evidence package",
      body: buildEvidenceMarkdown(review),
    });
  } catch (error) {
    ctx.logger.warn("quality_gate: failed to persist evidence document", {
      issueId: review.issueId,
      error: String(error),
    });
  }

  try {
    await ctx.issues.documents.upsert({
      issueId: review.issueId,
      companyId: review.companyId,
      key: getNextStepDocumentKey(),
      title: "Quality Gate Next Step",
      format: "markdown",
      changeSummary: "Update next-step template",
      body: buildNextStepMarkdown(review),
    });
  } catch (error) {
    ctx.logger.warn("quality_gate: failed to persist next-step document", {
      issueId: review.issueId,
      error: String(error),
    });
  }
}

export async function emitObservability(
  ctx: PluginContext,
  eventName: string,
  review: DeliverableReview,
  extras: Record<string, string | number | boolean> = {},
): Promise<void> {
  const tags = {
    companyId: review.companyId,
    status: review.status,
    category: review.category,
  };

  try {
    await ctx.metrics.write(`quality_gate.${eventName}`, 1, tags);
  } catch {
    // optional capability
  }

  try {
    await ctx.telemetry.track(eventName, { ...extras, issue_id: review.issueId, review_id: review.id });
  } catch {
    // optional capability
  }
}
