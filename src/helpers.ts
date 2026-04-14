// =============================================================================
// Quality Gate — Helpers
// =============================================================================

import type { PluginContext } from "@paperclipai/plugin-sdk";
import type {
  DeliverableReview,
  QualityCheckResult,
  ReviewActionLog,
  ReviewStatus,
} from "./types.js";

export const STATE_KEYS = {
  REVIEWS: "reviews",
} as const;

// ---------------------------------------------------------------------------
// State persistence helpers
// ---------------------------------------------------------------------------

type ReviewsMap = Record<string, DeliverableReview>;

export async function getReviewsMap(
  ctx: PluginContext,
): Promise<ReviewsMap> {
  const state = await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEYS.REVIEWS,
  });
  return (state?.value as ReviewsMap) ?? {};
}

export async function putReviewsMap(
  ctx: PluginContext,
  reviews: ReviewsMap,
): Promise<void> {
  await ctx.state.put(
    { scopeKind: "instance", stateKey: STATE_KEYS.REVIEWS },
    reviews,
  );
}

export async function getReview(
  ctx: PluginContext,
  issueId: string,
): Promise<DeliverableReview | null> {
  const reviews = await getReviewsMap(ctx);
  return reviews[issueId] ?? null;
}

export async function putReview(
  ctx: PluginContext,
  review: DeliverableReview,
): Promise<void> {
  const reviews = await getReviewsMap(ctx);
  reviews[review.issueId] = review;
  await putReviewsMap(ctx, reviews);
}

// ---------------------------------------------------------------------------
// Review factory helpers
// ---------------------------------------------------------------------------

export function buildNewReview(params: {
  issueId: string;
  summary?: string;
  qualityScore?: number;
  blockApproval?: boolean;
  reviewerName?: string;
}): DeliverableReview {
  const now = new Date().toISOString();
  const action: ReviewActionLog = {
    timestamp: now,
    action: "submitted for review",
    reviewer: "agent",
    reviewerName: params.reviewerName ?? "Agent",
    comment: params.summary,
    qualityScore: params.qualityScore,
  };
  return {
    issueId: params.issueId,
    status: "pending_review",
    deliverableSummary: params.summary,
    qualityScore: params.qualityScore,
    blockApproval: params.blockApproval ?? false,
    actionLog: [action],
    submittedAt: now,
    updatedAt: now,
  };
}

export function updateReviewStatus(
  review: DeliverableReview,
  newStatus: ReviewStatus,
  action: Omit<ReviewActionLog, "timestamp">,
): DeliverableReview {
  const now = new Date().toISOString();
  return {
    ...review,
    status: newStatus,
    actionLog: [...review.actionLog, { ...action, timestamp: now }],
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Quality evaluation
// ---------------------------------------------------------------------------

const QUALITY_THRESHOLD = 70; // minimum score to pass gate

export function evaluateDeliverable(params: {
  deliverableSummary?: string;
  qualityScore?: number;
  blockApproval?: boolean;
}): QualityCheckResult {
  const blockers: string[] = [];

  // Block if agent flagged a known limitation
  if (params.blockApproval) {
    blockers.push("Agent flagged a known limitation with block_approval=true");
  }

  const score = params.qualityScore ?? 5;
  const passed = score >= QUALITY_THRESHOLD && blockers.length === 0;

  return {
    score,
    passed,
    blockers,
    summary: passed
      ? `Quality score ${score} meets threshold (${QUALITY_THRESHOLD}).`
      : `Quality score ${score} below threshold (${QUALITY_THRESHOLD}) or blockers present.`,
  };
}
