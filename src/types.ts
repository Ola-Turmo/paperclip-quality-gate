export interface CustomCheck {
  id: string;
  name: string;
  type: "label_required" | "label_missing" | "title_contains" | "has_assignee";
  value?: string;
  scoreBonus?: number;
}

export interface QualityGateSettings {
  minQualityScore: number;
  blockThreshold: number;
  autoRejectBelow: number;
  customChecks?: CustomCheck[];
}

export interface IssueMetadata {
  labels?: string[];
  title?: string;
  assignee?: string;
  description?: string;
  status?: string;
}

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type QualityCategory =
  | "none"
  | "passed"
  | "needs_human_review"
  | "blocked"
  | "auto_rejected"
  | "rejected"
  | "escalated";

export interface QualityCheck {
  id: string;
  name: string;
  passed: boolean;
  score: number;
  details?: string;
}

export interface RiskFlag {
  id: string;
  label: string;
  level: RiskLevel;
  detail: string;
  source: "score" | "check" | "operator" | "system";
}

export interface EvidenceRef {
  id: string;
  kind: "issue" | "summary" | "comment" | "check" | "standard" | "trace" | "instruction" | "document";
  label: string;
  value: string;
}

export interface TraceStep {
  label: string;
  value: string;
  emphasis?: "observed" | "mutated" | "decision";
}

export interface EvidenceBundle {
  inputRefs: EvidenceRef[];
  retrievedContext: EvidenceRef[];
  standards: string[];
  trace: TraceStep[];
  hash: string;
  documentKey: string;
}

export interface DraftArtifact {
  artifactType: "deliverable_summary" | "message" | "document" | "generic";
  title: string;
  bodyMd: string;
  confidence: number;
  revision: number;
  riskLabels: string[];
}

export interface ReviewTrigger {
  source: "manual_submit" | "agent_run_finished" | "tool_submit" | "resubmission";
  actorLabel: string;
  agentId?: string;
  runId?: string;
  summary?: string;
  createdAt: string;
}

export interface ReleaseDecision {
  approvalState: "pending" | "approved_hold" | "released" | "rejected" | "escalated";
  approvedBy?: string;
  releasedBy?: string;
  releasedAt?: string;
}

export interface HandoffTask {
  targetAgentId?: string;
  instructionMd: string;
  status: "idle" | "queued" | "returned_to_agent" | "awaiting_agent" | "resolved" | "escalated";
  linkedIssueId?: string;
  updatedAt: string;
}

export interface ReviewSummary {
  headline: string;
  disposition: string;
  reviewerHint: string;
}

export interface QualityEvaluation {
  inputScore: number;
  decisionScore: number;
  overallScore: number;
  category: QualityCategory;
  checks: QualityCheck[];
  summary: string;
  autoRejected: boolean;
  blockThresholdBreached: boolean;
  passed: boolean;
  riskFlags: RiskFlag[];
}

export type ReviewStatus =
  | "pending_review"
  | "needs_human_review"
  | "auto_rejected"
  | "approved"
  | "rejected"
  | "escalated";

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
  decisionScore: number;
  blockApproval: boolean;
  category: QualityCategory;
  checks: QualityCheck[];
  riskFlags: RiskFlag[];
  evaluationSummary: string;
  submitterName: string;
  agentId?: string;
  assignedTo?: string;
  history: ReviewAction[];
  trigger: ReviewTrigger;
  evidenceBundle: EvidenceBundle;
  draftArtifact: DraftArtifact;
  releaseDecision: ReleaseDecision;
  handoffTask: HandoffTask;
  nextStepTemplate: string;
  reviewSummary: ReviewSummary;
  createdAt: string;
  updatedAt: string;
}

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

export interface ApproveHoldParams {
  issue_id: string;
  comment?: string;
}

export interface ReturnToAgentParams {
  issue_id: string;
  instruction: string;
  target_agent_id?: string;
}

export interface EscalateParams {
  issue_id: string;
  comment: string;
  escalate_to?: string;
}

export interface GenerateNextStepParams {
  issue_id: string;
  goal?: "revision" | "follow_up" | "release";
}

export interface ActionResult<T = unknown> {
  ok: boolean;
  review?: T;
  message?: string;
  error?: string;
  template?: string;
}

export interface IssueCreatedEvent {
  issue: { id: string; title?: string; status?: string; assigneeId?: string };
}

export interface IssueUpdatedEvent {
  issue: { id: string; title?: string; status?: string; assigneeId?: string };
  previousStatus?: string;
}

export interface AgentRunFinishedEvent {
  agentId: string;
  status: "completed" | "failed" | "cancelled";
  summary?: string;
  qualityScore?: number;
  blockApproval?: boolean;
}

export interface ReviewStatusData {
  review: DeliverableReview;
  issue?: { id: string; title?: string; status?: string };
}

export interface ReviewsListData {
  reviews: ReviewStatusData[];
  total: number;
}

export interface ReviewQueueItem {
  reviewId: string;
  issueId: string;
  title: string;
  status: ReviewStatus;
  approvalState: ReleaseDecision["approvalState"];
  decisionScore: number;
  qualityScore: number;
  assignedTo?: string;
  updatedAt: string;
  headline: string;
  topRiskLabel?: string;
  topRiskLevel?: RiskLevel;
}

export interface ReviewQueueSummary {
  totalReviews: number;
  pendingReviews: number;
  approvedHoldReviews: number;
  releasedReviews: number;
  escalatedReviews: number;
  revisionQueueReviews: number;
  highRiskReviews: number;
  unassignedPendingReviews: number;
  averageDecisionScore: number;
}

export interface ReviewQueueData {
  items: ReviewQueueItem[];
  summary: ReviewQueueSummary;
}

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
  recentScores?: { score: number; status: ReviewStatus; createdAt: string }[];
}

export interface QualityTrendsData {
  agents: AgentTrend[];
  overallAvgScore: number;
  totalReviews: number;
}
