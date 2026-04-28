import type {
  CustomCheck,
  DeliverableReview,
  DraftArtifact,
  EvidenceBundle,
  EvidenceRef,
  IssueMetadata,
  QualityCategory,
  QualityCheck,
  QualityEvaluation,
  QualityGateSettings,
  ReleaseDecision,
  ReviewAction,
  ReviewQueueData,
  ReviewQueueItem,
  ReviewStatus,
  ReviewStatusData,
  ReviewSummary,
  ReviewTrigger,
  RiskFlag,
  RiskLevel,
  TraceStep,
} from "./types.js";

export const STATE_KEYS = {
  REVIEWS: "reviews",
  REVIEW_IDS: "review_ids",
} as const;

const MAX_HISTORY_ENTRIES = 50;
const EVIDENCE_DOCUMENT_KEY = "quality-gate-evidence";
const NEXT_STEP_DOCUMENT_KEY = "quality-gate-next-step";

export function djb2(str: string): number {
  let hash = 5381;
  for (let index = 0; index < str.length; index += 1) {
    hash = (hash << 5) + hash + str.charCodeAt(index);
  }
  return Math.abs(hash);
}

function clampScore(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(10, value));
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const pairs = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`);
  return `{${pairs.join(",")}}`;
}

const REDACTION_PATTERNS: Array<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED PRIVATE KEY]",
  ],
  [/\bBearer\s+[A-Za-z0-9._-]{20,}\b/g, "Bearer [REDACTED]"],
  [/\bsk-[A-Za-z0-9]{20,}\b/g, "[REDACTED API KEY]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED GITHUB TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED AWS KEY]"],
];

export function redactSensitiveText(value: string, maxLength = 1200): string {
  let next = value;
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    next = next.replace(pattern, replacement);
  }

  if (next.length <= maxLength) return next;
  return `${next.slice(0, Math.max(0, maxLength - 14))}… [truncated]`;
}

function sanitizeOptionalText(
  value: string | undefined,
  maxLength = 1200,
): string | undefined {
  if (!value?.trim()) return undefined;
  return redactSensitiveText(value.trim(), maxLength);
}

export function buildEvidenceHash(value: unknown): string {
  return `qh_${djb2(stableSerialize(value)).toString(16)}`;
}

function riskLevelWeight(level: RiskLevel): number {
  switch (level) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    default:
      return 1;
  }
}

function deriveRiskFlags(
  inputScore: number | undefined,
  category: QualityCategory,
  checks: QualityCheck[],
  blockApproval: boolean,
): RiskFlag[] {
  const flags: RiskFlag[] = [];

  if (inputScore === undefined || inputScore === null) {
    flags.push({
      id: "missing-score",
      label: "Missing self-score",
      level: "medium",
      detail:
        "No self-assessed quality score was provided, so the review requires manual evaluation.",
      source: "score",
    });
  }

  if (blockApproval) {
    flags.push({
      id: "manual-block",
      label: "Manual hold requested",
      level: "high",
      detail: "The submitter explicitly requested a human review hold.",
      source: "operator",
    });
  }

  if (category === "auto_rejected") {
    flags.push({
      id: "auto-reject-threshold",
      label: "Below auto-reject threshold",
      level: "critical",
      detail:
        "The deliverable score fell below the configured auto-reject threshold.",
      source: "score",
    });
  } else if (category === "needs_human_review") {
    flags.push({
      id: "manual-review-range",
      label: "Needs human review",
      level: "high",
      detail:
        "The deliverable landed inside the human-review range or triggered a block condition.",
      source: "score",
    });
  }

  for (const check of checks.filter((item) => !item.passed)) {
    flags.push({
      id: `failed-${check.id}`,
      label: check.name,
      level: check.id.startsWith("custom_") ? "medium" : "high",
      detail: check.details ?? `${check.name} did not pass.`,
      source: "check",
    });
  }

  const deduped = new Map<string, RiskFlag>();
  for (const flag of flags) {
    deduped.set(flag.id, flag);
  }
  return Array.from(deduped.values()).sort(
    (left, right) => riskLevelWeight(right.level) - riskLevelWeight(left.level),
  );
}

function buildChecks(
  decisionScore: number,
  category: QualityCategory,
  rawScore: number | undefined,
  blockApproval: boolean,
  config: QualityGateSettings,
  bonusPoints: number,
): QualityCheck[] {
  return [
    {
      id: "score_threshold",
      name: "Quality score threshold",
      passed: category === "passed",
      score: decisionScore,
      details:
        rawScore !== undefined && rawScore !== null
          ? `Decision score ${decisionScore}/10 vs pass threshold ${config.minQualityScore}/10.`
          : "No score was provided by the submitter.",
    },
    {
      id: "review_window",
      name: "Human review window",
      passed: category !== "needs_human_review",
      score: decisionScore,
      details: blockApproval
        ? "Manual review was forced by the submitter."
        : decisionScore <= config.blockThreshold
          ? `Decision score ${decisionScore}/10 is within the review window (≤ ${config.blockThreshold}).`
          : "Deliverable is outside the forced-review window.",
    },
    {
      id: "auto_reject_guard",
      name: "Auto-reject guard",
      passed: category !== "auto_rejected",
      score: decisionScore,
      details:
        decisionScore < config.autoRejectBelow
          ? `Decision score ${decisionScore}/10 is below the auto-reject threshold ${config.autoRejectBelow}/10.`
          : `Decision score ${decisionScore}/10 cleared the auto-reject threshold ${config.autoRejectBelow}/10.`,
    },
    {
      id: "structured_bonus",
      name: "Structured check bonus",
      passed: bonusPoints > 0,
      score: bonusPoints,
      details:
        bonusPoints > 0
          ? `Custom checks contributed +${bonusPoints} bonus points to the decision score.`
          : "No bonus points were added by structured checks.",
    },
  ];
}

function evaluateCustomCheck(
  check: CustomCheck,
  issueData?: IssueMetadata,
): QualityCheck {
  let passed = false;
  let details: string;
  const labels = issueData?.labels ?? [];
  const title = issueData?.title ?? "";
  const assignee = issueData?.assignee;

  switch (check.type) {
    case "label_required": {
      const required = check.value ?? "";
      passed = labels.some(
        (label) => label.toLowerCase() === required.toLowerCase(),
      );
      details = passed
        ? `Required label "${required}" is present.`
        : `Required label "${required}" is missing.`;
      break;
    }
    case "label_missing": {
      const forbidden = check.value ?? "";
      passed = !labels.some(
        (label) => label.toLowerCase() === forbidden.toLowerCase(),
      );
      details = passed
        ? `Forbidden label "${forbidden}" is absent.`
        : `Forbidden label "${forbidden}" is present.`;
      break;
    }
    case "title_contains": {
      const keywords = (check.value ?? "")
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
      const titleLower = title.toLowerCase();
      const matched = keywords.filter((keyword) =>
        titleLower.includes(keyword),
      );
      passed = keywords.length === 0 || matched.length === keywords.length;
      details =
        keywords.length === 0
          ? "No keywords configured."
          : passed
            ? `Title contains all required keywords: ${matched.join(", ")}.`
            : `Missing keywords: ${keywords.filter((keyword) => !matched.includes(keyword)).join(", ")}.`;
      break;
    }
    case "has_assignee": {
      passed = Boolean(assignee && assignee.trim());
      details = passed
        ? `Issue is assigned to ${assignee}.`
        : "Issue has no assignee.";
      break;
    }
    default: {
      details = "Unknown custom check type.";
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

function buildSummary(
  decisionScore: number,
  overallScore: number,
  category: QualityCategory,
  config: QualityGateSettings,
  rawScore: number | undefined,
  bonusPoints: number,
): string {
  const rawSegment =
    rawScore === undefined || rawScore === null
      ? "No self-score was provided"
      : `Input score ${rawScore}/10`;
  const bonusSegment =
    bonusPoints > 0
      ? `, plus ${bonusPoints} structured-check bonus point(s)`
      : "";

  switch (category) {
    case "auto_rejected":
      return `${rawSegment}${bonusSegment} produced a decision score of ${decisionScore}/10, which is below the auto-reject threshold ${config.autoRejectBelow}/10. The work should be revised before another submission.`;
    case "needs_human_review":
      return `${rawSegment}${bonusSegment} produced a decision score of ${decisionScore}/10. The deliverable stays in the human-review lane and needs reviewer attention before release.`;
    case "passed":
      return `${rawSegment}${bonusSegment} produced a decision score of ${decisionScore}/10 and an overall display score of ${overallScore}/10. The evidence package is ready for reviewer approval.`;
    case "none":
      return "No self-score was provided, so the deliverable was packaged for manual review with an evidence bundle.";
    default:
      return `${rawSegment}${bonusSegment} produced an overall display score of ${overallScore}/10.`;
  }
}

export function evaluateQuality(
  score: number | undefined,
  blockApproval: boolean,
  config: QualityGateSettings,
  issueData?: IssueMetadata,
): QualityEvaluation {
  const inputScore = clampScore(score);
  const customChecks = (config.customChecks ?? []).map((check) =>
    evaluateCustomCheck(check, issueData),
  );
  const bonusPoints = customChecks.reduce(
    (sum, check) => sum + (check.passed ? check.score : 0),
    0,
  );
  const decisionScore = clampScore(inputScore + bonusPoints);

  let category: QualityCategory;
  let autoRejected = false;
  let blockThresholdBreached = false;
  let passed = false;

  if (score === undefined || score === null) {
    category = "none";
    blockThresholdBreached = true;
  } else if (blockApproval) {
    category = "needs_human_review";
    blockThresholdBreached = true;
  } else if (decisionScore < config.autoRejectBelow) {
    category = "auto_rejected";
    autoRejected = true;
  } else if (decisionScore <= config.blockThreshold) {
    category = "needs_human_review";
    blockThresholdBreached = true;
  } else if (decisionScore >= config.minQualityScore) {
    category = "passed";
    passed = true;
  } else {
    category = "needs_human_review";
  }

  const variant =
    (djb2(`${category}:${decisionScore}:${score ?? "none"}`) % 3) - 1;
  const overallScore = clampScore(decisionScore + variant);
  const baseChecks = buildChecks(
    decisionScore,
    category,
    score,
    blockApproval,
    config,
    bonusPoints,
  );
  const checks = [...baseChecks, ...customChecks];
  const riskFlags = deriveRiskFlags(score, category, checks, blockApproval);
  const summary = buildSummary(
    decisionScore,
    overallScore,
    category,
    config,
    score,
    bonusPoints,
  );

  return {
    inputScore,
    decisionScore,
    overallScore,
    category,
    checks,
    summary,
    autoRejected,
    blockThresholdBreached,
    passed,
    riskFlags,
  };
}

function buildDefaultStandards(): string[] {
  return [
    "quality-score-threshold",
    "human-in-the-loop-approval",
    "traceable-evidence-package",
    "paperclip-issue-audit-trail",
  ];
}

export function buildEvidenceBundle(input: {
  issueId: string;
  summary?: string;
  comment?: string;
  trigger: ReviewTrigger;
  issueData?: IssueMetadata;
  checks: QualityCheck[];
  riskFlags: RiskFlag[];
}): EvidenceBundle {
  const inputRefs: EvidenceRef[] = [
    { id: "issue", kind: "issue", label: "Issue", value: input.issueId },
  ];

  const sanitizedTitle = sanitizeOptionalText(input.issueData?.title, 160);
  const sanitizedSummary = sanitizeOptionalText(input.summary, 1400);
  const sanitizedComment = sanitizeOptionalText(input.comment, 1200);

  if (sanitizedTitle) {
    inputRefs.push({
      id: "title",
      kind: "issue",
      label: "Title",
      value: sanitizedTitle,
    });
  }
  if (sanitizedSummary) {
    inputRefs.push({
      id: "summary",
      kind: "summary",
      label: "Submitted summary",
      value: sanitizedSummary,
    });
  }
  if (sanitizedComment) {
    inputRefs.push({
      id: "comment",
      kind: "comment",
      label: "Operator comment",
      value: sanitizedComment,
    });
  }

  const retrievedContext: EvidenceRef[] = [];
  const sanitizedDescription = sanitizeOptionalText(
    input.issueData?.description,
    600,
  );
  if (sanitizedDescription) {
    retrievedContext.push({
      id: "description",
      kind: "document",
      label: "Issue description",
      value: sanitizedDescription,
    });
  }
  if (input.issueData?.status) {
    retrievedContext.push({
      id: "status",
      kind: "trace",
      label: "Issue status",
      value: input.issueData.status,
    });
  }
  if (input.issueData?.labels?.length) {
    retrievedContext.push({
      id: "labels",
      kind: "trace",
      label: "Labels",
      value: input.issueData.labels.join(", "),
    });
  }
  if (input.issueData?.assignee) {
    retrievedContext.push({
      id: "assignee",
      kind: "trace",
      label: "Assignee",
      value: input.issueData.assignee,
    });
  }
  for (const flag of input.riskFlags.slice(0, 6)) {
    retrievedContext.push({
      id: flag.id,
      kind: "trace",
      label: `Risk · ${flag.label}`,
      value: flag.detail,
    });
  }

  const trace: TraceStep[] = [
    {
      label: "Trigger",
      value: `${input.trigger.source} by ${input.trigger.actorLabel}`,
      emphasis: "observed",
    },
    { label: "Issue", value: input.issueId, emphasis: "observed" },
    {
      label: "Check count",
      value: `${input.checks.length}`,
      emphasis: "decision",
    },
    {
      label: "Risk count",
      value: `${input.riskFlags.length}`,
      emphasis: "decision",
    },
  ];
  if (input.trigger.runId) {
    trace.push({
      label: "Run ID",
      value: input.trigger.runId,
      emphasis: "observed",
    });
  }
  if (input.trigger.agentId) {
    trace.push({
      label: "Agent",
      value: input.trigger.agentId,
      emphasis: "observed",
    });
  }

  const standards = buildDefaultStandards();
  const hash = buildEvidenceHash({
    inputRefs,
    retrievedContext,
    standards,
    trace,
  });

  return {
    inputRefs,
    retrievedContext,
    standards,
    trace,
    hash,
    documentKey: EVIDENCE_DOCUMENT_KEY,
  };
}

export function buildDraftArtifact(input: {
  issueId: string;
  issueData?: IssueMetadata;
  summary?: string;
  evaluation: QualityEvaluation;
  revision: number;
}): DraftArtifact {
  const title =
    sanitizeOptionalText(input.issueData?.title, 180) ||
    `Deliverable review for ${input.issueId}`;
  const sanitizedSummary = sanitizeOptionalText(input.summary, 1600);
  const sanitizedDescription = sanitizeOptionalText(
    input.issueData?.description,
    1600,
  );
  const body = [
    sanitizedSummary ? `### Submitted output\n${sanitizedSummary}` : undefined,
    sanitizedDescription
      ? `### Source brief\n${sanitizedDescription}`
      : undefined,
    `### Evaluation summary\n${input.evaluation.summary}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const riskLabels = input.evaluation.riskFlags.map((flag) => flag.label);
  const confidence = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        (input.evaluation.overallScore / 10) * 100 - riskLabels.length * 6,
      ),
    ),
  );

  return {
    artifactType: "deliverable_summary",
    title,
    bodyMd:
      body ||
      "No draft body was supplied. Review the linked issue context and evidence bundle.",
    confidence,
    revision: input.revision,
    riskLabels,
  };
}

export function buildReviewSummary(
  review: Pick<
    DeliverableReview,
    "status" | "category" | "draftArtifact" | "riskFlags" | "releaseDecision"
  >,
): ReviewSummary {
  const riskHeadline =
    review.riskFlags.length > 0
      ? `${review.riskFlags[0].label}${review.riskFlags.length > 1 ? ` +${review.riskFlags.length - 1} more` : ""}`
      : "No active risks flagged";

  const disposition =
    review.releaseDecision.approvalState === "released"
      ? "Released"
      : review.releaseDecision.approvalState === "approved_hold"
        ? "Approved and held"
        : review.status === "escalated"
          ? "Escalated"
          : review.status === "rejected" || review.status === "auto_rejected"
            ? "Needs revision"
            : "Awaiting reviewer action";

  const reviewerHint =
    review.status === "auto_rejected"
      ? "Revise the output before another submission."
      : review.status === "needs_human_review"
        ? "Inspect the evidence bundle, draft artifact, and risk cards before deciding."
        : review.releaseDecision.approvalState === "approved_hold"
          ? "Work is approved but still held. Release when downstream delivery is safe."
          : review.releaseDecision.approvalState === "released"
            ? "The package has been released and the audit trail is complete."
            : "Review the evidence package and choose the next operator action.";

  return {
    headline: `${review.draftArtifact.title} · ${riskHeadline}`,
    disposition,
    reviewerHint,
  };
}

function buildReleaseDecision(
  state: ReleaseDecision["approvalState"] = "pending",
): ReleaseDecision {
  return { approvalState: state };
}

function buildHandoffTask(): DeliverableReview["handoffTask"] {
  return {
    instructionMd: "",
    status: "idle",
    updatedAt: new Date().toISOString(),
  };
}

export function buildNextStepTemplate(
  review: DeliverableReview,
  goal: "revision" | "follow_up" | "release" = "revision",
): string {
  const headline =
    goal === "release"
      ? "Release checklist"
      : goal === "follow_up"
        ? "Follow-up instruction"
        : "Revision brief";
  const riskLines =
    review.riskFlags.length > 0
      ? review.riskFlags
          .map((flag) => `- [${flag.level}] ${flag.label}: ${flag.detail}`)
          .join("\n")
      : "- No active risk flags.";
  const checkLines =
    review.checks
      .filter((check) => !check.passed)
      .map(
        (check) =>
          `- ${check.name}: ${check.details ?? "Review the failed check."}`,
      )
      .join("\n") || "- No failing checks were recorded.";

  return [
    `# ${headline}`,
    "",
    `Issue: ${review.issueId}`,
    `Current status: ${review.status}`,
    `Release state: ${review.releaseDecision.approvalState}`,
    `Evidence hash: ${review.evidenceBundle.hash}`,
    "",
    "## Why this gate fired",
    review.evaluationSummary,
    "",
    "## Risks to address",
    riskLines,
    "",
    "## Failing or watch-list checks",
    checkLines,
    "",
    "## Recommended next action",
    goal === "release"
      ? "- Confirm downstream destination, recipient, or operator approval context.\n- Release the approved deliverable and log the final send context."
      : goal === "follow_up"
        ? "- Ask the responsible agent or reviewer to acknowledge the evidence bundle.\n- Capture any missing business context before the next decision."
        : "- Revise the draft artifact using the evidence and risk sections.\n- Resubmit with an updated summary and quality score once changes are complete.",
  ].join("\n");
}

export function buildEvidenceMarkdown(review: DeliverableReview): string {
  const sections = [
    `# Quality gate evidence package`,
    "",
    `- Issue: ${review.issueId}`,
    `- Review ID: ${review.id}`,
    `- Evidence hash: ${review.evidenceBundle.hash}`,
    `- Trigger: ${review.trigger.source} by ${review.trigger.actorLabel}`,
    `- Display score: ${review.qualityScore}/10`,
    `- Decision score: ${review.decisionScore}/10`,
    "",
    "## Draft artifact",
    `### ${review.draftArtifact.title}`,
    review.draftArtifact.bodyMd,
    "",
    "## Input references",
    ...review.evidenceBundle.inputRefs.map(
      (ref) => `- **${ref.label}** (${ref.kind}): ${ref.value}`,
    ),
    "",
    "## Retrieved context",
    ...review.evidenceBundle.retrievedContext.map(
      (ref) => `- **${ref.label}** (${ref.kind}): ${ref.value}`,
    ),
    "",
    "## Standards invoked",
    ...review.evidenceBundle.standards.map((standard) => `- ${standard}`),
    "",
    "## Trace",
    ...review.evidenceBundle.trace.map(
      (step) => `- ${step.label}: ${step.value}`,
    ),
    "",
    "## Risks",
    ...(review.riskFlags.length > 0
      ? review.riskFlags.map(
          (flag) =>
            `- **${flag.level.toUpperCase()}** ${flag.label}: ${flag.detail}`,
        )
      : ["- No active risk flags."]),
    "",
    "## Checks",
    ...review.checks.map(
      (check) =>
        `- ${check.passed ? "✅" : "❌"} **${check.name}** — ${check.details ?? "No details"} (score ${check.score})`,
    ),
  ];

  return sections.join("\n");
}

export function buildNextStepMarkdown(review: DeliverableReview): string {
  return review.nextStepTemplate || buildNextStepTemplate(review);
}

function deriveInitialStatus(evaluation: QualityEvaluation): ReviewStatus {
  if (evaluation.autoRejected) return "auto_rejected";
  if (evaluation.blockThresholdBreached || evaluation.category === "none")
    return "needs_human_review";
  return "pending_review";
}

export function buildNewReview(fields: {
  issueId: string;
  companyId: string;
  summary?: string;
  comment?: string;
  qualityScore?: number;
  blockApproval?: boolean;
  reviewerName: string;
  agentId?: string;
  trigger: ReviewTrigger;
  issueData?: IssueMetadata;
  evaluation: QualityEvaluation;
}): DeliverableReview {
  const now = new Date().toISOString();
  const draftArtifact = buildDraftArtifact({
    issueId: fields.issueId,
    issueData: fields.issueData,
    summary: fields.summary,
    evaluation: fields.evaluation,
    revision: 1,
  });
  const evidenceBundle = buildEvidenceBundle({
    issueId: fields.issueId,
    summary: fields.summary,
    comment: fields.comment,
    trigger: fields.trigger,
    issueData: fields.issueData,
    checks: fields.evaluation.checks,
    riskFlags: fields.evaluation.riskFlags,
  });

  const review: DeliverableReview = {
    id: `review_${fields.issueId}_${crypto.randomUUID()}`,
    issueId: fields.issueId,
    companyId: fields.companyId,
    status: deriveInitialStatus(fields.evaluation),
    qualityScore: fields.evaluation.overallScore,
    decisionScore: fields.evaluation.decisionScore,
    blockApproval: fields.blockApproval ?? false,
    category: fields.evaluation.category,
    checks: fields.evaluation.checks,
    riskFlags: fields.evaluation.riskFlags,
    evaluationSummary: fields.evaluation.summary,
    submitterName: fields.reviewerName,
    agentId: fields.agentId,
    history: [
      {
        action: "submitted",
        reviewer: fields.agentId ? "agent" : "user",
        reviewerName: fields.reviewerName,
        comment: sanitizeOptionalText(fields.summary, 1000),
        qualityScore: fields.evaluation.overallScore,
        createdAt: now,
      },
    ],
    trigger: fields.trigger,
    evidenceBundle,
    draftArtifact,
    releaseDecision: buildReleaseDecision(),
    handoffTask: buildHandoffTask(),
    nextStepTemplate: "",
    reviewSummary: {
      headline: "",
      disposition: "",
      reviewerHint: "",
    },
    createdAt: now,
    updatedAt: now,
  };
  review.nextStepTemplate = buildNextStepTemplate(review);
  review.reviewSummary = buildReviewSummary(review);
  return review;
}

export function updateReviewStatus(
  review: DeliverableReview,
  status: ReviewStatus,
  action: Omit<ReviewAction, "createdAt">,
  patch: Partial<DeliverableReview> = {},
): DeliverableReview {
  const now = new Date().toISOString();
  const nextHistory = [...review.history, { ...action, createdAt: now }].slice(
    -MAX_HISTORY_ENTRIES,
  );
  const nextReleaseDecision = patch.releaseDecision ?? review.releaseDecision;
  const nextHandoffTask = patch.handoffTask ?? review.handoffTask;

  const next: DeliverableReview = {
    ...review,
    ...patch,
    status,
    releaseDecision: nextReleaseDecision,
    handoffTask: nextHandoffTask,
    history: nextHistory,
    updatedAt: now,
  };
  next.reviewSummary = buildReviewSummary(next);
  next.nextStepTemplate =
    patch.nextStepTemplate ??
    (review.nextStepTemplate || buildNextStepTemplate(next));
  return next;
}

export function applyEvaluationToReview(
  review: DeliverableReview,
  input: {
    summary?: string;
    comment?: string;
    evaluation: QualityEvaluation;
    trigger: ReviewTrigger;
    issueData?: IssueMetadata;
    reviewerName: string;
    agentId?: string;
    blockApproval?: boolean;
  },
): DeliverableReview {
  const revision = review.draftArtifact.revision + 1;
  const draftArtifact = buildDraftArtifact({
    issueId: review.issueId,
    issueData: input.issueData,
    summary: input.summary,
    evaluation: input.evaluation,
    revision,
  });
  const evidenceBundle = buildEvidenceBundle({
    issueId: review.issueId,
    summary: input.summary,
    comment: input.comment,
    trigger: input.trigger,
    issueData: input.issueData,
    checks: input.evaluation.checks,
    riskFlags: input.evaluation.riskFlags,
  });

  const next = updateReviewStatus(
    review,
    deriveInitialStatus(input.evaluation),
    {
      action: "resubmitted",
      reviewer: input.agentId ? "agent" : "user",
      reviewerName: input.reviewerName,
      comment: sanitizeOptionalText(input.comment ?? input.summary, 1000),
      qualityScore: input.evaluation.overallScore,
      auto: false,
    },
    {
      qualityScore: input.evaluation.overallScore,
      decisionScore: input.evaluation.decisionScore,
      blockApproval: input.blockApproval ?? review.blockApproval,
      category: input.evaluation.category,
      checks: input.evaluation.checks,
      riskFlags: input.evaluation.riskFlags,
      evaluationSummary: input.evaluation.summary,
      agentId: input.agentId ?? review.agentId,
      trigger: input.trigger,
      evidenceBundle,
      draftArtifact,
      releaseDecision: buildReleaseDecision(),
      handoffTask: buildHandoffTask(),
    },
  );

  next.nextStepTemplate = buildNextStepTemplate(next);
  next.reviewSummary = buildReviewSummary(next);
  return next;
}

export function assignReview(
  review: DeliverableReview,
  assignedTo: string,
  reviewerName: string,
): DeliverableReview {
  return updateReviewStatus(
    review,
    review.status,
    {
      action: "assigned",
      reviewer: "user",
      reviewerName,
      comment: `Assigned to ${assignedTo}`,
    },
    {
      assignedTo,
    },
  );
}

export function buildSubmitComment(review: DeliverableReview): string {
  const lines = [
    "## Quality Gate — Evidence Package Submitted",
    "",
    `**Display score:** ${review.qualityScore}/10`,
    `**Decision score:** ${review.decisionScore}/10`,
    `**Status:** ${review.status}`,
    `**Evidence hash:** ${review.evidenceBundle.hash}`,
    "",
    review.evaluationSummary,
    "",
    `Top reviewer cue: ${review.reviewSummary.reviewerHint}`,
  ];
  if (review.blockApproval) {
    lines.push("", "⚠️ Manual hold requested by the submitter.");
  }
  return lines.join("\n");
}

export function buildApproveHoldComment(comment?: string): string {
  return [
    "## ✅ Quality Gate — Approved (Held)",
    "",
    "The evidence package was approved by a reviewer, but downstream release is still on hold.",
    comment ? `\n> ${redactSensitiveText(comment, 600)}` : undefined,
    "",
    "_Use Approve & Release when the destination or next action is ready._",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildApproveComment(comment?: string): string {
  return [
    "## 🚀 Quality Gate — Approved & Released",
    "",
    "The deliverable passed human review and has been released.",
    comment ? `\n> ${redactSensitiveText(comment, 600)}` : undefined,
    "",
    "_Audit trail updated._",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildRejectComment(comment: string): string {
  return [
    "## ❌ Quality Gate — Revision Requested",
    "",
    "The deliverable needs revision before it can move forward.",
    "",
    `> ${redactSensitiveText(comment, 900)}`,
    "",
    "_Use the next-step template and evidence bundle to prepare the resubmission._",
  ].join("\n");
}

export function buildReturnToAgentComment(
  instruction: string,
  targetAgentId?: string,
): string {
  const mention = targetAgentId ? `@${targetAgentId} ` : "";
  return [
    "## ↩️ Quality Gate — Returned to Agent",
    "",
    `${mention}The deliverable was returned to the responsible agent with structured revision guidance.`,
    "",
    redactSensitiveText(instruction, 1200),
  ].join("\n");
}

export function buildEscalateComment(
  comment: string,
  escalateTo?: string,
): string {
  return [
    "## 🛡️ Quality Gate — Escalated",
    "",
    escalateTo
      ? `Escalated to **${escalateTo}** for higher-scope review.`
      : "Escalated for higher-scope review.",
    "",
    `> ${redactSensitiveText(comment, 900)}`,
  ].join("\n");
}

export function buildAutoRejectComment(
  score: number,
  autoRejectBelow: number,
): string {
  return [
    "## ⚠️ Quality Gate — Auto-Rejected",
    "",
    `Decision score ${score}/10 is below the auto-reject threshold ${autoRejectBelow}/10.`,
    "",
    "_Revise the output and resubmit with an updated evidence package._",
  ].join("\n");
}

export function mapTargetStatus(category: QualityCategory): string | null {
  switch (category) {
    case "passed":
    case "needs_human_review":
    case "none":
      return "in_review";
    case "auto_rejected":
    case "rejected":
      return "in_progress";
    case "blocked":
    case "escalated":
      return "blocked";
    default:
      return null;
  }
}

export function buildTelemetryEnvelope(
  review: DeliverableReview,
  decisionType: string,
): Record<string, string | number | boolean> {
  return {
    company_id: review.companyId,
    issue_id: review.issueId,
    review_id: review.id,
    decision_type: decisionType,
    status: review.status,
    category: review.category,
    display_score: review.qualityScore,
    decision_score: review.decisionScore,
    review_required:
      review.status === "needs_human_review" ||
      review.status === "pending_review",
    risk_count: review.riskFlags.length,
    released: review.releaseDecision.approvalState === "released",
  };
}

export function buildReviewQueueData(
  records: ReviewStatusData[],
): ReviewQueueData {
  const sorted = [...records].sort(
    (left, right) =>
      new Date(right.review.updatedAt).getTime() -
      new Date(left.review.updatedAt).getTime(),
  );
  const items: ReviewQueueItem[] = sorted.map(({ review, issue }) => ({
    reviewId: review.id,
    issueId: review.issueId,
    title: issue?.title ?? review.draftArtifact.title,
    status: review.status,
    approvalState: review.releaseDecision.approvalState,
    decisionScore: review.decisionScore,
    qualityScore: review.qualityScore,
    assignedTo: review.assignedTo,
    updatedAt: review.updatedAt,
    headline: review.reviewSummary.headline,
    topRiskLabel: review.riskFlags[0]?.label,
    topRiskLevel: review.riskFlags[0]?.level,
  }));

  const totalDecisionScore = items.reduce(
    (sum, item) => sum + item.decisionScore,
    0,
  );
  const pendingReviews = items.filter(
    (item) =>
      (item.status === "pending_review" ||
        item.status === "needs_human_review") &&
      item.approvalState === "pending",
  ).length;
  const approvedHoldReviews = items.filter(
    (item) => item.approvalState === "approved_hold",
  ).length;
  const releasedReviews = items.filter(
    (item) => item.approvalState === "released",
  ).length;
  const escalatedReviews = items.filter(
    (item) => item.status === "escalated" || item.approvalState === "escalated",
  ).length;
  const revisionQueueReviews = items.filter(
    (item) => item.status === "rejected" || item.status === "auto_rejected",
  ).length;
  const highRiskReviews = sorted.filter(({ review }) =>
    review.riskFlags.some(
      (flag) => flag.level === "high" || flag.level === "critical",
    ),
  ).length;
  const unassignedPendingReviews = items.filter(
    (item) =>
      (item.status === "pending_review" ||
        item.status === "needs_human_review") &&
      item.approvalState === "pending" &&
      !item.assignedTo?.trim(),
  ).length;

  return {
    items,
    summary: {
      totalReviews: items.length,
      pendingReviews,
      approvedHoldReviews,
      releasedReviews,
      escalatedReviews,
      revisionQueueReviews,
      highRiskReviews,
      unassignedPendingReviews,
      averageDecisionScore:
        items.length > 0
          ? Math.round((totalDecisionScore / items.length) * 10) / 10
          : 0,
    },
  };
}

export function getEvidenceDocumentKey(): string {
  return EVIDENCE_DOCUMENT_KEY;
}

export function getNextStepDocumentKey(): string {
  return NEXT_STEP_DOCUMENT_KEY;
}
