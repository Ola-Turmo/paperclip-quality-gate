import type { Issue, IssueComment } from "@paperclipai/shared";

// ── Config ──────────────────────────────────────────────────────────────────

export interface QualityGateSettings {
  minQualityScore: number;
  blockThreshold: number;
  autoRejectBelow: number;
}

// ── Evaluation ──────────────────────────────────────────────────────────────

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
  totalReviews: number;
  avgQualityScore: number;
  approvedCount: number;
  rejectedCount: number;
  autoRejectedCount: number;
  needsHumanReviewCount: number;
  approvalRate: number;
  autoRejectRate: number;
}

export interface QualityTrendsData {
  agents: AgentTrend[];
  overallAvgScore: number;
  totalReviews: number;
}
