/**
 * uos-quality-gate plugin worker.
 *
 * Architecture: worker.ts is the thin orchestration layer.
 * All business logic is delegated to focused modules:
 *   - helpers.ts   — pure evaluation, review building, comment formatting
 *   - shared.ts    — runtime helpers that need PluginContext
 *   - actions.ts   — quality_gate.submit / approve / reject
 *   - tools.ts     — quality_gate_review / submit_for_review agent tools
 *   - events.ts    — agent.run.finished / failed / issue.created / updated
 */
import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import type { Issue } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID, PLUGIN_VERSION } from "./manifest.js";
import type { QualityTrendsData, ReviewsListData } from "./types.js";
import { STATE_KEYS } from "./helpers.js";
import { setupActions } from "./actions.js";
import { setupTools } from "./tools.js";
import { setupEvents } from "./events.js";
import { getConfig, getReview } from "./shared.js";

// ── Data registrations (remain here — bridge between ctx.state and public API) ──

function registerData(ctx: PluginContext): void {
  ctx.data.register("quality_gate.config", async () => {
    return await getConfig(ctx);
  });

  ctx.data.register("quality_gate.review", async (params) => {
    const issueId = params["issueId"] as string;
    if (!issueId) return null;

    let review = null;
    try {
      review = await getReview(ctx, issueId);
    } catch {
      return null;
    }
    if (!review) return null;

    let issue: Issue | null = null;
    try {
      if (review.companyId) {
        issue = await ctx.issues.get(issueId, review.companyId);
      }
    } catch {
      // issue may have been deleted — return review without issue
    }

    const data: {
      review: typeof review;
      issue?: { id: string; title: string; status: string | undefined };
    } = { review };
    if (issue) {
      data.issue = { id: issue.id, title: issue.title, status: issue.status ?? undefined };
    }
    return data;
  });

  ctx.data.register("quality_gate.reviews", async (params) => {
    const companyId = (params["companyId"] as string) ?? "";
    if (!companyId) return { reviews: [], total: 0 };

    const ids = ((await ctx.state.get({
      scopeKind: "company" as const,
      scopeId: companyId,
      stateKey: STATE_KEYS.REVIEW_IDS,
    })) as string[] | null) ?? [];

    const idslice = ids.slice(0, 50);

    // Parallel fetch with concurrency limit of 10
    const CONCURRENCY = 10;
    const results = [];
    for (let i = 0; i < idslice.length; i += CONCURRENCY) {
      const batch = idslice.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async (reviewId): Promise<{ review: import("./types.js").DeliverableReview; issue?: { id: string; title: string; status: string } } | null> => {
          const parts = reviewId.split("_");
          const issueId = parts[1];
          if (!issueId) return null;

          try {
            const review = await getReview(ctx, issueId);
            if (!review) return null;
            let issue: Issue | null = null;
            try {
              issue = await ctx.issues.get(issueId, companyId);
            } catch {
              // issue deleted — still surface the review
            }
            return {
              review,
              issue: issue
                ? { id: issue.id, title: issue.title, status: issue.status ?? "" }
                : undefined,
            };
          } catch {
            // skip corrupted review
            return null;
          }
        }),
      );
      for (const r of batchResults) {
        if (r) results.push(r);
      }
    }

    return { reviews: results, total: ids.length } as ReviewsListData;
  });

  ctx.data.register("quality_gate.trends", async (params) => {
    const companyId = (params["companyId"] as string) ?? "";
    if (!companyId) return { agents: [], overallAvgScore: 0, totalReviews: 0 } as QualityTrendsData;

    const ids = ((await ctx.state.get({
      scopeKind: "company" as const,
      scopeId: companyId,
      stateKey: STATE_KEYS.REVIEW_IDS,
    })) as string[] | null) ?? [];

    // Fetch all reviews in parallel batches
    const CONCURRENCY = 10;
    const allReviews: import("./types.js").DeliverableReview[] = [];
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const batch = ids.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async (reviewId) => {
          const parts = reviewId.split("_");
          const issueId = parts[1];
          if (!issueId) return null;
          try {
            return await getReview(ctx, issueId);
          } catch {
            return null;
          }
        }),
      );
      for (const r of batchResults) {
        if (r) allReviews.push(r);
      }
    }

    if (allReviews.length === 0) {
      return { agents: [], overallAvgScore: 0, totalReviews: 0 } as QualityTrendsData;
    }

    // Group reviews by agentId
    const byAgent = new Map<string, import("./types.js").DeliverableReview[]>();
    for (const review of allReviews) {
      const key = review.agentId ?? "_manual_";
      if (!byAgent.has(key)) byAgent.set(key, []);
      byAgent.get(key)!.push(review);
    }

    // Compute per-agent trends
    const agents: import("./types.js").AgentTrend[] = [];
    let totalScore = 0;
    for (const [agentId, reviews] of Array.from(byAgent.entries())) {
      // Sort newest first for recentScores
      const sorted = [...reviews].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      const scores = sorted.map((r) => r.qualityScore);
      const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
      totalScore += scores.reduce((a, b) => a + b, 0);
      const approvedCount = sorted.filter((r) => r.status === "approved").length;
      const rejectedCount = sorted.filter((r) => r.status === "rejected").length;
      const autoRejectedCount = sorted.filter((r) => r.status === "auto_rejected").length;
      const needsHumanReviewCount = sorted.filter((r) => r.status === "needs_human_review").length;
      agents.push({
        agentId,
        displayName: agentId === "_manual_" ? "Manual Submission" : agentId,
        totalReviews: sorted.length,
        avgQualityScore: Math.round(avgScore * 10) / 10,
        approvedCount,
        rejectedCount,
        autoRejectedCount,
        needsHumanReviewCount,
        approvalRate: Math.round((approvedCount / sorted.length) * 1000) / 10,
        autoRejectRate: Math.round((autoRejectedCount / sorted.length) * 1000) / 10,
        recentScores: sorted.slice(0, 10).map((r) => ({
          score: r.qualityScore,
          status: r.status,
          createdAt: r.createdAt,
        })),
      });
    }

    // Sort agents by totalReviews descending
    agents.sort((a, b) => b.totalReviews - a.totalReviews);

    return {
      agents,
      overallAvgScore: Math.round((totalScore / allReviews.length) * 10) / 10,
      totalReviews: allReviews.length,
    } as QualityTrendsData;
  });
}

// ── Plugin definition ──────────────────────────────────────────────────────────

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
