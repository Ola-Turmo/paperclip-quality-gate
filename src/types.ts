import type { Issue, IssueComment } from "@paperclipai/shared";

// ── Config ──────────────────────────────────────────────────────────────────

/**
 * Custom quality checks — defined in plugin config, evaluated at review time.
 * Each check is a structured rule (no arbitrary code execution).
 * Custom checks are evaluated against the issue's current metadata (labels, title, assignee).
 */
export interface CustomCheck {
  id: string;
  name: string;
  /** The type of check — determines which fields of `params` are used. */
  type:
    | "label_required"    // params.value = label name
    | "label_missing"     // params.value = label name
    | "title_contains"    // params.value = comma-separated keywords
    | "has_assignee";     // no params needed
  /** Type-specific parameter value. */
  value?: string;
  /** Score contribution (0–10) when passed. Defaults to 0. */
  scoreBonus?: number;
}

export interface QualityGateSettings {
  minQualityScore: number;
  blockThreshold: number;
  autoRejectBelow: number;
  /** Structured custom checks evaluated at every review. */
  customChecks?: CustomCheck[];
}

/**
 * Issue metadata used during custom check evaluation.
 * Populated at evaluation time from the live issue object.
 */
export interface IssueMetadata {
  labels?: string[];
  title?: string;
  assignee?: string;
}

export type QualityCategory =
  | "none"
  | "passed"
  | "needs_human_review"
  | "blocked"
  | "auto_rejected"
  | "rejected";

export interface QualityCheck {
  id: string;
  name: string;
  passed: boolean;
  score: number;
  details?: string;
}

export interface QualityEvaluation {
  overallScore: number;
  category: QualityCategory;
  checks: QualityCheck[];
  summary: string;
  autoRejected: boolean;
  blockThresholdBreached: boolean;
  passed: boolean;
}

// ── Review ──────────────────────────────────────────────────────────────────

export type ReviewStatus =
  | "pending_review"
  | "needs_human_review"
  | "auto_rejected"
  | "approved"
  | "rejected";

export interface ReviewAction {
  action: string;
  reviewer: "user" | "agent" | "system";
  reviewerName: string;
  comment?: string;
  qualityScore?: number;
  auto?: boolean;
  createdAt: string;
}

export interface DeliverableReview {
  id: string;
  issueId: string;
  companyId: string;
  status: ReviewStatus;
  qualityScore: number;
  blockApproval: boolean;
  category: QualityCategory;
  checks: QualityCheck[];
  evaluationSummary: string;
  submitterName: string;
  agentId?: string;
  assignedTo?: string;
  history: ReviewAction[];
  createdAt: string;
  updatedAt: string;
}

// ── Action params ───────────────────────────────────────────────────────────

export interface SubmitForReviewParams {
  issue_id: string;
  summary?: string;
  quality_score?: number;
  block_approval?: boolean;
  comment?: string;
}

export interface ApproveParams {
  issue_id: string;
  comment?: string;
}

export interface RejectParams {
  issue_id: string;
  comment: string;
}

export interface AssignParams {
  issue_id: string;
  assigned_to: string;
}

export interface BulkApproveParams {
  issue_ids: string[];
  comment?: string;
}

export interface BulkRejectParams {
  issue_ids: string[];
  comment: string;
}

// ── Standard result ─────────────────────────────────────────────────────────

export interface ActionResult<T = unknown> {
  ok: boolean;
  review?: T;
  message?: string;
  error?: string;
}

// ── Event payloads ──────────────────────────────────────────────────────────

export interface IssueCreatedEvent {
  issue: { id: string; title?: string; status?: string; assigneeId?: string };
}

export interface IssueUpdatedEvent {
  issue: { id: string; title?: string; status?: string; assigneeId?: string };
  previousStatus?: string;
}

export interface CommentCreatedEvent {
  comment: { id: string; body?: string; authorId?: string };
  issueId: string;
}

export interface AgentRunFinishedEvent {
  agentId: string;
  status: "completed" | "failed" | "cancelled";
  summary?: string;
  qualityScore?: number;
  blockApproval?: boolean;
}

// ── UI data shapes ──────────────────────────────────────────────────────────

export interface ReviewStatusData {
  review: DeliverableReview;
  issue?: { id: string; title?: string; status?: string };
}

export interface ReviewsListData {
  reviews: ReviewStatusData[];
  total: number;
}

// ── Agent tools ─────────────────────────────────────────────────────────────

export interface QualityGateReviewInput {
  issue_id: string;
  include_checks?: boolean;
}

export interface SubmitForReviewInput {
  issue_id: string;
  summary?: string;
  quality_score?: number;
  block_approval?: boolean;
  comment?: string;
}

// ── Trend analytics ──────────────────────────────────────────────────────────

export interface AgentTrend {
  agentId: string;
  displayName: string;
  avgQualityScore: number;
  approvedCount: number;
  rejectedCount: number;
  autoRejectedCount: number;
  needsHumanReviewCount: number;
  approvalRate: number;
  autoRejectRate: number;
  totalReviews: number;
  /** Most recent quality scores (newest first) for score history. */
  recentScores?: { score: number; status: ReviewStatus; createdAt: string }[];
}
export interface QualityTrendsData {
  agents: AgentTrend[];
  overallAvgScore: number;
  totalReviews: number;
}
