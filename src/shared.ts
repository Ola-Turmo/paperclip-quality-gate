/**
 * Shared runtime helpers used across actions, tools, and events.
 * These require a PluginContext and are separated from pure helpers.ts
 * to keep the worker.ts split clean.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG } from "./manifest.js";
import type {
  ApproveParams,
  QualityGateSettings,
  RejectParams,
  SubmitForReviewParams,
} from "./types.js";
import { STATE_KEYS } from "./helpers.js";
import type { DeliverableReview } from "./types.js";

// ── Param cast ────────────────────────────────────────────────────────────────

/**
 * Type-safe params cast for action handlers.
 * The SDK passes params as Record<string, unknown>, but we know the shape at runtime.
 * Using as unknown as to suppress TypeScript's conservative overlap check — safe because
 * the action schema enforces required fields at registration time.
 */
export function castParams<T>(params: Record<string, unknown>): T {
  return params as unknown as T;
}

// ── Config ───────────────────────────────────────────────────────────────────

export async function getConfig(
  ctx: PluginContext,
): Promise<QualityGateSettings> {
  const config = await ctx.config.get();
  return { ...DEFAULT_CONFIG, ...(config as Partial<QualityGateSettings>) };
}

// ── State helpers ────────────────────────────────────────────────────────────

export async function getReview(
  ctx: PluginContext,
  issueId: string,
): Promise<DeliverableReview | null> {
  const review = await ctx.state.get({
    scopeKind: "issue" as const,
    scopeId: issueId,
    stateKey: STATE_KEYS.REVIEWS,
  });
  return (review as DeliverableReview | null) ?? null;
}

export async function putReview(
  ctx: PluginContext,
  review: DeliverableReview,
): Promise<void> {
  // Per-issue atomic state — concurrent writes on different issues never contend.
  await ctx.state.set(
    { scopeKind: "issue" as const, scopeId: review.issueId, stateKey: STATE_KEYS.REVIEWS },
    review,
  );
  // Maintain a company-level index of review IDs for list queries
  const indexKey = {
    scopeKind: "company" as const,
    scopeId: review.companyId,
    stateKey: STATE_KEYS.REVIEW_IDS,
  };
  const ids = ((await ctx.state.get(indexKey)) as string[] | null) ?? [];
  const next = ids.includes(review.id)
    ? ids
    : [review.id, ...ids].slice(0, 200);
  await ctx.state.set(indexKey, next);
}
