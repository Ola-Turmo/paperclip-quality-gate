import type {
  CustomCheck,
  DeliverableReview,
  IssueMetadata,
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

/** Maximum history entries stored per review to prevent unbounded growth. */
const MAX_HISTORY_ENTRIES = 50;

// ── Deterministic hash (djb2) ───────────────────────────────────────────────

function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
  }
  return Math.abs(hash);
}

// ── Quality evaluation ───────────────────────────────────────────────────────

export function evaluateQuality(
  score: number | undefined,
  blockApproval: boolean,
  config: QualityGateSettings,
  issueData?: IssueMetadata,
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

  // Evaluate custom checks (structured rules from plugin config)
  const customChecks = config.customChecks ?? [];
  for (const check of customChecks) {
    const result = evaluateCustomCheck(check, issueData);
    checks.push(result);
  }

  const summary = buildSummary(overallScore, category, autoRejected, blockThresholdBreached, passed, score);

  return { overallScore, category, checks, summary, autoRejected, blockThresholdBreached, passed } as QualityEvaluation;
}

/**
 * Evaluate a single structured custom check against issue metadata.
 * Returns a QualityCheck result (passed/failed with score contribution).
 */
function evaluateCustomCheck(check: CustomCheck, issueData?: IssueMetadata): QualityCheck {
  let passed = false;
  let details = "";
  const labels = issueData?.labels ?? [];
  const title = issueData?.title ?? "";
  const assignee = issueData?.assignee;

  switch (check.type) {
    case "label_required": {
      const required = check.value ?? "";
      passed = labels.some((l) => l.toLowerCase() === required.toLowerCase());
      details = passed
        ? `Required label "${required}" is present`
        : `Required label "${required}" is missing`;
      break;
    }
    case "label_missing": {
      const forbidden = check.value ?? "";
      passed = !labels.some((l) => l.toLowerCase() === forbidden.toLowerCase());
      details = passed
        ? `Label "${forbidden}" is correctly absent`
        : `Label "${forbidden}" should not be present`;
      break;
    }
    case "title_contains": {
      const keywords = (check.value ?? "").split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
      if (keywords.length === 0) {
        passed = true;
        details = "No keywords configured";
      } else {
        const titleLower = title.toLowerCase();
        const matched = keywords.filter((k) => titleLower.includes(k));
        passed = matched.length === keywords.length;
        details = passed
          ? `Title contains all required keywords: ${matched.join(", ")}`
          : `Title missing keywords: ${keywords.filter((k) => !matched.includes(k)).join(", ")}`;
      }
      break;
    }
    case "has_assignee": {
      passed = Boolean(assignee && assignee.trim() !== "");
      details = passed
        ? `Issue is assigned to ${assignee}`
        : "Issue has no assignee";
      break;
    }
    default: {
      details = `Unknown check type`;
      break;
    }
  }

  return {
    id: `custom_${check.id}`,
    name: check.name,
    passed,
    score: passed ? (check.scoreBonus ?? 0) : 0,
    details,
  };
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
  agentId?: string;
  qualityChecks?: QualityCheck[];
  evaluationSummary?: string;
  category?: string;
  status?: ReviewStatus;
}): DeliverableReview {
  const now = new Date().toISOString();

  return {
    id: `review_${fields.issueId}_${crypto.randomUUID()}`,
    issueId: fields.issueId,
    companyId: fields.companyId,
    status: fields.status ?? "pending_review",
    qualityScore: fields.qualityScore ?? 0,
    blockApproval: fields.blockApproval ?? false,
    category: (fields.category ?? "none") as QualityCategory,
    checks: fields.qualityChecks ?? [],
    evaluationSummary: fields.evaluationSummary ?? "",
    submitterName: fields.reviewerName,
    agentId: fields.agentId,
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
  // Cap history at MAX_HISTORY_ENTRIES to prevent unbounded growth
  const nextHistory = [...review.history, { ...action, createdAt: now }].slice(
    -MAX_HISTORY_ENTRIES,
  );
  return {
    ...review,
    status,
    updatedAt: now,
    history: nextHistory,
  };
}

export function assignReview(
  review: DeliverableReview,
  assignedTo: string,
  reviewerName: string,
): DeliverableReview {
  const now = new Date().toISOString();
  const nextHistory = [
    ...review.history,
    {
      action: "assigned",
      reviewer: "user",
      reviewerName,
      comment: `Assigned to ${assignedTo}`,
      createdAt: now,
    } as ReviewAction,
  ].slice(-MAX_HISTORY_ENTRIES);
  return {
    ...review,
    assignedTo,
    updatedAt: now,
    history: nextHistory,
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
