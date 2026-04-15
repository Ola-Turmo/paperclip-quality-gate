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
import type { ReviewsListData } from "./types.js";
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
