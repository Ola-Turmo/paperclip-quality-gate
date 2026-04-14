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
}

/** The complete review record for one issue's deliverable. */
export interface DeliverableReview {
  issueId: string;
  status: ReviewStatus;
  deliverableSummary?: string;
  qualityScore?: number;
  blockApproval: boolean;
  actionLog: ReviewActionLog[];
  submittedAt: string;
  updatedAt: string;
}

/** Tool input shape for the `quality_gate_review` agent tool. */
export interface QualityGateReviewInput {
  issue_id: string;
  deliverable_summary?: string;
  quality_score?: number;
  block_approval?: boolean;
}

/** Tool output shape returned by the `quality_gate_review` handler. */
// NOTE: issue.created / issue.updated / issue.comment_created payloads are
// passed as plain PluginEvent — the issue/comment fields are on event.payload.
export type IssueCreatedEvent = { payload: { issue?: { id?: string; title?: string } } };
export type IssueUpdatedEvent = { payload: { issue?: { id?: string; title?: string } } };
export type CommentCreatedEvent = {
  payload: {
    issue?: { id?: string };
    comment?: { body?: string; authorName?: string };
  };
};
export interface QualityGateReviewOutput {
  success: boolean;
  review: DeliverableReview;
  message: string;
}

/** Quality check result computed by the worker. */
export interface QualityCheckResult {
  score: number;
  passed: boolean;
  blockers: string[];
  summary: string;
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
