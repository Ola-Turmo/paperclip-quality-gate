import type {
  DeliverableReview,
  QualityCategory,
  QualityCheck,
  QualityEvaluation,
  QualityGateSettings,
  ReviewAction,
  ReviewStatus,
} from "./types.js";

// ── Constants ────────────────────────────────────────────────────────────────

export const STATE_KEYS = {
  REVIEWS: "reviews",          // per-issue: DeliverableReview
  REVIEW_IDS: "review_ids",    // per-company: string[]
} as const;

// ── Deterministic hash (djb2) ───────────────────────────────────────────────

function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
  }
  return Math.abs(hash);
}

// ── Quality evaluation ──────────────────────────────────────────────────────

export function evaluateQuality(
  score: number | undefined,
  blockApproval: boolean,
  config: QualityGateSettings,
): QualityEvaluation {
  const base = score ?? 0;

  let category: QualityCategory;
  let autoRejected = false;
  let blockThresholdBreached = false;
  let passed = false;

  if (score === undefined || score === null) {
    category = "none";
  } else if (score < config.autoRejectBelow) {
    category = "auto_rejected";
    autoRejected = true;
  } else if (blockApproval || score <= config.blockThreshold) {
    category = "needs_human_review";
    blockThresholdBreached = true;
  } else if (score >= config.minQualityScore) {
    category = "passed";
    passed = true;
  } else {
    // Score is between blockThreshold and minQualityScore — already handled above
    category = "needs_human_review";
  }

  // Deterministic ±1 variance per category/score to provide varied check results
  const variant = (djb2(category + String(score)) % 3) - 1; // -1, 0, or +1
  const overallScore = Math.max(0, Math.min(10, base + variant));

  // Build per-category check breakdown
  const checks: QualityCheck[] = buildChecks(overallScore, category, score, blockApproval ?? false);

  const summary = buildSummary(overallScore, category, autoRejected, blockThresholdBreached, passed, score);

  return { overallScore, category, checks, summary, autoRejected, blockThresholdBreached, passed } as QualityEvaluation;
}

function buildChecks(
  overallScore: number,
  category: QualityCategory,
  rawScore: number | undefined,
  blockApproval: boolean,
): QualityCheck[] {
  const now = new Date().toISOString();
  const checks: QualityCheck[] = [];

  // Score check
  checks.push({
    id: "score_threshold",
    name: "Quality Score Threshold",
    passed: category !== "none" && category !== "auto_rejected",
    score: overallScore,
    details: rawScore !== undefined
      ? `Score ${rawScore} ${rawScore >= 7 ? "meets" : "below"} minimum threshold`
      : "No score provided",
  });

  // Blocker check
  checks.push({
    id: "no_blockers",
    name: "No Blocker Flags",
    passed: category !== "blocked" && category !== "needs_human_review",
    score: blockApproval ? 0 : overallScore,
    details: blockApproval
      ? "Block approval flag set — requires human review"
      : "No blocking issues detected",
  });

  // Auto-reject check
  checks.push({
    id: "auto_reject",
    name: "Auto-Reject Check",
    passed: category !== "auto_rejected",
    score: overallScore,
    details: category === "auto_rejected"
      ? `Score below auto-reject threshold (${rawScore} < threshold)`
      : "Above auto-reject threshold",
  });

  return checks;
}

function buildSummary(
  overallScore: number,
  category: QualityCategory,
  autoRejected: boolean,
  blockThresholdBreached: boolean,
  passed: boolean,
  rawScore: number | undefined,
): string {
  if (category === "none") {
    return "No quality score provided — deliverable requires human review.";
  }
  if (autoRejected) {
    return `Quality score ${rawScore} is below the auto-reject threshold. ` +
           "Work has been automatically rejected — please address quality concerns and resubmit.";
  }
  if (blockThresholdBreached) {
    return `Quality score ${rawScore} is within the review range. ` +
           "A reviewer must approve before this deliverable can be marked complete.";
  }
  if (passed) {
    return `Quality score ${overallScore} meets the minimum threshold. ` +
           "Deliverable is ready for human final review and approval.";
  }
  return `Quality score ${overallScore} requires review before approval.`;
}

// ── Review helpers ──────────────────────────────────────────────────────────

export function buildNewReview(fields: {
  issueId: string;
  companyId: string;
  summary?: string;
  qualityScore?: number;
  blockApproval?: boolean;
  reviewerName: string;
  qualityChecks?: QualityCheck[];
  evaluationSummary?: string;
  category?: string;
  status?: ReviewStatus;
}): DeliverableReview {
  const now = new Date().toISOString();

  return {
    id: `review_${fields.issueId}_${Date.now()}`,
    issueId: fields.issueId,
    companyId: fields.companyId,
    status: fields.status ?? "pending_review",
    qualityScore: fields.qualityScore ?? 0,
    blockApproval: fields.blockApproval ?? false,
    category: (fields.category ?? "none") as QualityCategory,
    checks: fields.qualityChecks ?? [],
    evaluationSummary: fields.evaluationSummary ?? "",
    submitterName: fields.reviewerName,
    history: [
      {
        action: "submitted",
        reviewer: "user",
        reviewerName: fields.reviewerName,
        comment: fields.summary,
        qualityScore: fields.qualityScore,
        createdAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

export function updateReviewStatus(
  review: DeliverableReview,
  status: ReviewStatus,
  action: Omit<ReviewAction, "createdAt">,
): DeliverableReview {
  const now = new Date().toISOString();
  return {
    ...review,
    status,
    updatedAt: now,
    history: [
      ...review.history,
      { ...action, createdAt: now },
    ],
  };
}

// ── Comment builders ────────────────────────────────────────────────────────

export function buildSubmitComment(p: {
  qualityScore: number;
  evaluationSummary: string;
  blockApproval?: boolean;
  qualityChecks: QualityCheck[];
}): string {
  const lines = [
    "## Quality Gate — Deliverable Submitted",
    "",
    `**Score:** ${p.qualityScore}/10`,
    `**Status:** Awaiting review`,
    "",
    p.evaluationSummary,
    "",
  ];
  if (p.blockApproval) {
    lines.push("⚠️ Block approval flag was set — manual review required.");
  }
  return lines.join("\n");
}

export function buildApproveComment(comment?: string): string {
  const lines = [
    "## ✅ Quality Gate — Approved",
    "",
    "This deliverable has been approved by a reviewer.",
  ];
  if (comment) {
    lines.push("", `> ${comment}`);
  }
  lines.push("", "_Quality gate passed._");
  return lines.join("\n");
}

export function buildRejectComment(comment: string): string {
  const lines = [
    "## ❌ Quality Gate — Rejected",
    "",
    "This deliverable has been rejected and returned to the agent.",
    "",
    `> ${comment}`,
    "",
    "_Please address the feedback and resubmit for review._",
  ];
  return lines.join("\n");
}

export function buildAutoRejectComment(score: number, autoRejectBelow: number): string {
  return [
    "## ⚠️ Quality Gate — Auto-Rejected",
    "",
    `Score ${score} is below the auto-reject threshold of ${autoRejectBelow}.`,
    "",
    "This deliverable has been automatically rejected. Please improve quality and resubmit.",
    "",
    "_No human review was performed._",
  ].join("\n");
}

// ── Status mapping ─────────────────────────────────────────────────────────

/**
 * Maps quality evaluation category → Paperclip issue status.
 * Returns null when no status change should be made.
 */
export function mapTargetStatus(
  category: QualityCategory,
): string | null {
  switch (category) {
    case "passed":
    case "needs_human_review":
      return "in_review";
    case "auto_rejected":
    case "rejected":
      return "in_progress";
    case "blocked":
      return "blocked";
    default:
      return null;
  }
}
