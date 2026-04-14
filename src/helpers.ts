// =============================================================================
// Quality Gate — Helpers
// =============================================================================

import type { PluginContext } from "@paperclipai/plugin-sdk";
import type {
  DeliverableReview,
  QualityCheck,
  QualityCheckCategory,
  QualityEvaluation,
  QualityGateConfig,
  QualityGateReviewInput,
  ReviewActionLog,
  ReviewStatus,
} from "./types.js";

import { DEFAULT_CONFIG } from "./types.js";

// ---------------------------------------------------------------------------
// State key constants
// ---------------------------------------------------------------------------

export const STATE_KEYS = {
  REVIEWS: "reviews",
  CONFIG: "config",
} as const;

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

export async function getConfig(
  ctx: PluginContext,
): Promise<QualityGateConfig> {
  const state = await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEYS.CONFIG,
  });
  return (state?.value as QualityGateConfig) ?? DEFAULT_CONFIG;
}

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
  companyId: string;
  summary?: string;
  qualityScore?: number;
  blockApproval?: boolean;
  reviewerName?: string;
  qualityChecks?: QualityCheck[];
  evaluationSummary?: string;
}): DeliverableReview {
  const now = new Date().toISOString();
  const action: ReviewActionLog = {
    timestamp: now,
    action: "submitted for review",
    reviewer: "agent",
    reviewerName: params.reviewerName ?? "Agent",
    comment: params.summary,
    qualityScore: params.qualityScore,
    auto: false,
  };
  return {
    issueId: params.issueId,
    companyId: params.companyId,
    status: "pending_review",
    deliverableSummary: params.summary,
    qualityScore: params.qualityScore,
    blockApproval: params.blockApproval ?? false,
    qualityChecks: params.qualityChecks,
    evaluationSummary: params.evaluationSummary,
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

const CATEGORY_WEIGHTS: Record<QualityCheckCategory, number> = {
  completeness: 0.30,
  correctness: 0.30,
  clarity: 0.20,
  test_coverage: 0.10,
  documentation: 0.10,
};

function evaluateCategory(
  category: QualityCheckCategory,
  score: number,
  hasBlocker: boolean,
): QualityCheck {
  const passed = score >= 6 && !hasBlocker;
  return {
    category,
    passed,
    score,
    message: getCategoryMessage(category, score, hasBlocker),
  };
}

function getCategoryMessage(
  category: QualityCheckCategory,
  score: number,
  hasBlocker: boolean,
): string {
  if (hasBlocker) return "⚠️ Blocker flagged — requires human review before approval.";
  switch (category) {
    case "completeness":
      return score >= 8
        ? "✅ All required components present"
        : score >= 6
        ? "⚠️ Minor gaps in scope"
        : "❌ Significant scope gaps or missing parts";
    case "correctness":
      return score >= 8
        ? "✅ No logical errors detected"
        : score >= 6
        ? "⚠️ Minor correctness concerns"
        : "❌ Logical errors or bugs likely present";
    case "clarity":
      return score >= 8
        ? "✅ Clear and well-documented"
        : score >= 6
        ? "⚠️ Some sections unclear"
        : "❌ Poorly documented or confusing";
    case "test_coverage":
      return score >= 8
        ? "✅ Good test coverage"
        : score >= 5
        ? "⚠️ Limited test coverage"
        : "❌ Missing or inadequate tests";
    case "documentation":
      return score >= 8
        ? "✅ Well-documented"
        : score >= 5
        ? "⚠️ Documentation could be improved"
        : "❌ Documentation missing";
    default:
      return "";
  }
}

function computeWeightedScore(checks: QualityCheck[]): number {
  let total = 0;
  let weightSum = 0;
  for (const check of checks) {
    const weight = CATEGORY_WEIGHTS[check.category] ?? 0.1;
    total += check.score * weight;
    weightSum += weight;
  }
  return weightSum > 0 ? Math.round((total / weightSum) * 10) / 10 : 0;
}

/**
 * Sophisticated multi-category quality evaluation.
 * Accepts explicit self-assessment scores OR derives them from the single quality_score.
 */
export function evaluateDeliverable(params: {
  qualityScore?: number;
  blockApproval?: boolean;
  selfAssessment?: QualityGateReviewInput["self_assessment"];
  config?: QualityGateConfig;
}): QualityEvaluation {
  const cfg = params.config ?? DEFAULT_CONFIG;
  const blockers: string[] = [];
  const checks: QualityCheck[] = [];

  // Agent-flagged blocker always requires human review
  if (params.blockApproval) {
    blockers.push(
      "Agent flagged a known limitation with block_approval=true — human review required.",
    );
  }

  // Build per-category checks
  if (params.selfAssessment) {
    const sa = params.selfAssessment;
    for (const [cat, score] of Object.entries(sa) as [
      QualityCheckCategory,
      number,
    ][]) {
      if (score === undefined) continue;
      checks.push(
        evaluateCategory(
          cat,
          Math.max(0, Math.min(10, score)),
          params.blockApproval ?? false,
        ),
      );
    }
  } else {
    // Fall back to single score: add ±1 variance per category
    const base = params.qualityScore ?? 5;
    const categories: QualityCheckCategory[] = [
      "completeness",
      "correctness",
      "clarity",
      "test_coverage",
      "documentation",
    ];
    for (const cat of categories) {
      const variance = Math.round((Math.random() - 0.5) * 2);
      const score = Math.max(0, Math.min(10, base + variance));
      checks.push(
        evaluateCategory(cat, score, params.blockApproval ?? false),
      );
    }
  }

  const overallScore = computeWeightedScore(checks);
  const failedChecks = checks.filter((c) => !c.passed);

  // Auto-reject very low scores
  const autoRejected = overallScore < cfg.autoRejectBelow;

  // Determine pass/fail
  const hasBlockers = blockers.length > 0;
  const anyFailedChecks = failedChecks.length > 0;
  const passed =
    !autoRejected &&
    overallScore >= cfg.minQualityScore &&
    !hasBlockers &&
    !anyFailedChecks;

  if (autoRejected) {
    blockers.push(
      `Score ${overallScore} is below auto-reject threshold (${cfg.autoRejectBelow}) — automatically rejected.`,
    );
  } else if (overallScore < cfg.minQualityScore) {
    blockers.push(
      `Score ${overallScore} below minimum threshold (${cfg.minQualityScore}).`,
    );
  }

  const summary = passed
    ? `✅ Quality gate passed (score: ${overallScore}/10).`
    : autoRejected
    ? `❌ Auto-rejected (score: ${overallScore}/10 below ${cfg.autoRejectBelow}).`
    : blockers.length > 0
    ? `⚠️ Quality gate blocked — ${blockers[0]}`
    : `⚠️ Quality score ${overallScore}/10 is below minimum (${cfg.minQualityScore}).`;

  return {
    overallScore,
    passed,
    autoRejected,
    checks,
    blockers,
    summary,
  };
}
