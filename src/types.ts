// =============================================================================
// Quality Gate — Shared Types
// =============================================================================

export type ReviewStatus = "pending_review" | "approved" | "rejected";
export type ReviewerType = "agent" | "user";

/** A single entry in the review action log. */
export interface ReviewActionLog {
  timestamp: string;
  action: string;
  reviewer: ReviewerType;
  reviewerName: string;
  comment?: string;
  qualityScore?: number;
  auto?: boolean; // true if this was an automated action
}

/** The complete review record for one issue's deliverable. */
export interface DeliverableReview {
  issueId: string;
  companyId: string;
  status: ReviewStatus;
  deliverableSummary?: string;
  qualityScore?: number;
  blockApproval: boolean;
  /** Whether this review was auto-rejected (score < autoRejectBelow). */
  autoRejected?: boolean;
  /** Structured quality check results */
  qualityChecks?: QualityCheck[];
  /** Human-readable evaluation summary */
  evaluationSummary?: string;
  actionLog: ReviewActionLog[];
  submittedAt: string;
  updatedAt: string;
}

/** Result of a single quality check category. */
export interface QualityCheck {
  category: QualityCheckCategory;
  passed: boolean;
  score: number; // 0–10
  message?: string;
}

export type QualityCheckCategory =
  | "completeness"
  | "clarity"
  | "correctness"
  | "test_coverage"
  | "documentation";

/** Overall quality evaluation result. */
export interface QualityEvaluation {
  overallScore: number; // 0–10 weighted average
  passed: boolean;
  /** Score < autoRejectBelow — agent can retry without human review */
  autoRejected: boolean;
  /** Score between blockThreshold and autoRejectBelow — needs human review, issue → blocked */
  blockThresholdBreached: boolean;
  checks: QualityCheck[];
  blockers: string[]; // human-readable blocking issues
  summary: string;
}

/** Tool input shape for the `quality_gate_review` agent tool. */
export interface QualityGateReviewInput {
  issue_id: string;
  deliverable_summary?: string;
  quality_score?: number;
  block_approval?: boolean;
  /** Detailed self-assessment per category (optional, enables richer evaluation) */
  self_assessment?: {
    completeness?: number;
    clarity?: number;
    correctness?: number;
    test_coverage?: number;
    documentation?: number;
  };
}

/** Tool output shape returned by the `quality_gate_review` handler. */
export interface QualityGateReviewOutput {
  success: boolean;
  review: DeliverableReview;
  evaluation: QualityEvaluation;
  message: string;
}

/** Plugin instance configuration — matches instanceConfigSchema in manifest. */
export interface QualityGateConfig {
  minQualityScore: number; // default 7
  blockThreshold: number;   // default 5
  autoRejectBelow: number;  // default 3
}

/** Action params — submit for review (user-initiated). */
export interface SubmitForReviewParams {
  issue_id: string;
  summary?: string;
  quality_score?: number;
  block_approval?: boolean;
}

/** Action params — approve deliverable. */
export interface ApproveParams {
  issue_id: string;
  comment?: string;
}

/** Action params — reject deliverable. */
export interface RejectParams {
  issue_id: string;
  comment: string;
}

/** UI data shape for `review_status`. */
export interface ReviewStatusData {
  review: DeliverableReview | null;
}

/** UI data shape for `review_history`. */
export interface ReviewHistoryData {
  actions: ReviewActionLog[];
}

/** Event type for the review_updated stream channel. */
export interface ReviewUpdatedEvent {
  issueId: string;
  review: DeliverableReview;
}

/** Issue status values available in Paperclip UOS. */
export type IssueStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked"
  | "cancelled";

/**
 * Typed event payload wrappers used internally.
 * These match what Paperclip emits on the event bus.
 */
export interface IssueCreatedEvent {
  payload: { issue?: { id?: string; title?: string } };
  companyId?: string;
}
export interface IssueUpdatedEvent {
  payload: { issue?: { id?: string; title?: string } };
  companyId?: string;
}
export interface CommentCreatedEvent {
  payload: {
    issue?: { id?: string };
    comment?: { body?: string; authorName?: string };
  };
  companyId?: string;
}

// ---------------------------------------------------------------------------
// Default config (shared between manifest and helpers)
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: QualityGateConfig = {
  minQualityScore: 7,
  blockThreshold: 5,
  autoRejectBelow: 3,
};
