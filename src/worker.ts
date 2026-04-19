import { definePlugin, runWorker, type PluginContext, type Issue } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID, PLUGIN_VERSION } from "./manifest.js";
import type {
  AgentTrend,
  DeliverableReview,
  QualityTrendsData,
  ReviewQueueData,
  ReviewStatusData,
  ReviewsListData,
} from "./types.js";
import { STATE_KEYS, buildReviewQueueData } from "./helpers.js";
import { setupActions } from "./actions.js";
import { setupEvents } from "./events.js";
import { setupTools } from "./tools.js";
import { getConfig, getReview } from "./shared.js";

function getIssueIdFromIndexEntry(value: string): string | null {
  if (!value) return null;
  if (!value.startsWith("review_")) return value;
  const lastUnderscore = value.lastIndexOf("_");
  if (lastUnderscore <= "review_".length) return null;
  return value.slice("review_".length, lastUnderscore) || null;
}

async function loadIssueSummary(ctx: PluginContext, issueId: string, companyId: string): Promise<ReviewStatusData["issue"]> {
  try {
    const issue = await ctx.issues.get(issueId, companyId);
    return issue ? { id: issue.id, title: issue.title, status: issue.status ?? undefined } : undefined;
  } catch {
    return undefined;
  }
}

async function loadCompanyReviewRecords(
  ctx: PluginContext,
  companyId: string,
  limit = 50,
): Promise<{ records: ReviewStatusData[]; total: number }> {
  if (!companyId) return { records: [], total: 0 };

  const ids = ((await ctx.state.get({
    scopeKind: "company" as const,
    scopeId: companyId,
    stateKey: STATE_KEYS.REVIEW_IDS,
  })) as string[] | null) ?? [];

  const reviewIds = ids.slice(0, Math.max(0, limit));
  const records: ReviewStatusData[] = [];

  for (let index = 0; index < reviewIds.length; index += 10) {
    const batch = reviewIds.slice(index, index + 10);
    const results = await Promise.all(batch.map(async (reviewId) => {
      const issueId = getIssueIdFromIndexEntry(reviewId);
      if (!issueId) return null;

      const review = await getReview(ctx, issueId);
      if (!review) return null;

      return {
        review,
        issue: await loadIssueSummary(ctx, issueId, companyId),
      } satisfies ReviewStatusData;
    }));

    for (const result of results) {
      if (result) records.push(result);
    }
  }

  return { records, total: ids.length };
}

function buildTrends(reviews: DeliverableReview[]): QualityTrendsData {
  if (reviews.length === 0) {
    return { agents: [], overallAvgScore: 0, totalReviews: 0 };
  }

  const byAgent = new Map<string, DeliverableReview[]>();
  for (const review of reviews) {
    const agentKey = review.agentId ?? "_manual_";
    if (!byAgent.has(agentKey)) byAgent.set(agentKey, []);
    byAgent.get(agentKey)!.push(review);
  }

  let totalScore = 0;
  const agents: AgentTrend[] = [];

  for (const [agentId, items] of byAgent.entries()) {
    const sorted = [...items].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
    const scores = sorted.map((review) => review.qualityScore);
    const approvedCount = sorted.filter((review) => review.releaseDecision.approvalState === "released").length;
    const rejectedCount = sorted.filter((review) => review.status === "rejected").length;
    const autoRejectedCount = sorted.filter((review) => review.status === "auto_rejected").length;
    const needsHumanReviewCount = sorted.filter((review) => review.status === "needs_human_review" || review.status === "pending_review").length;
    const sum = scores.reduce((accumulator, score) => accumulator + score, 0);
    totalScore += sum;

    agents.push({
      agentId,
      displayName: agentId === "_manual_" ? "Manual submission" : agentId,
      avgQualityScore: Math.round((sum / scores.length) * 10) / 10,
      approvedCount,
      rejectedCount,
      autoRejectedCount,
      needsHumanReviewCount,
      approvalRate: Math.round((approvedCount / sorted.length) * 1000) / 10,
      autoRejectRate: Math.round((autoRejectedCount / sorted.length) * 1000) / 10,
      totalReviews: sorted.length,
      recentScores: sorted.slice(0, 10).map((review) => ({
        score: review.qualityScore,
        status: review.status,
        createdAt: review.createdAt,
      })),
    });
  }

  agents.sort((left, right) => right.totalReviews - left.totalReviews);

  return {
    agents,
    overallAvgScore: Math.round((totalScore / reviews.length) * 10) / 10,
    totalReviews: reviews.length,
  };
}

function registerData(ctx: PluginContext): void {
  ctx.data.register("quality_gate.config", async () => getConfig(ctx));

  ctx.data.register("quality_gate.review", async (params) => {
    const issueId = (params["issueId"] as string) || (params["issue_id"] as string) || (params["entityId"] as string);
    if (!issueId) return null;

    const review = await getReview(ctx, issueId);
    if (!review) return null;

    return {
      review,
      issue: await loadIssueSummary(ctx, issueId, review.companyId),
    } satisfies ReviewStatusData;
  });

  ctx.data.register("quality_gate.reviews", async (params) => {
    const companyId = (params["companyId"] as string) ?? "";
    const limit = typeof params["limit"] === "number" ? Number(params["limit"]) : 50;
    const { records, total } = await loadCompanyReviewRecords(ctx, companyId, limit);
    return { reviews: records, total } satisfies ReviewsListData;
  });

  ctx.data.register("quality_gate.trends", async (params) => {
    const companyId = (params["companyId"] as string) ?? "";
    const { records } = await loadCompanyReviewRecords(ctx, companyId, 200);
    return buildTrends(records.map(({ review }) => review));
  });

  ctx.data.register("quality_gate.queue", async (params) => {
    const companyId = (params["companyId"] as string) ?? "";
    const { records } = await loadCompanyReviewRecords(ctx, companyId, 200);
    return buildReviewQueueData(records) satisfies ReviewQueueData;
  });

}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_ID} v${PLUGIN_VERSION} starting up`);
    registerData(ctx);
    setupActions(ctx);
    setupTools(ctx);
    setupEvents(ctx);
    ctx.logger.info(`${PLUGIN_ID} setup complete`);
  },

  async onHealth() {
    return { status: "ok", version: PLUGIN_VERSION };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
