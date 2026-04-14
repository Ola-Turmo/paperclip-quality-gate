import * as React from "react";
import {
  usePluginAction,
  usePluginData,
  usePluginStream,
  type PluginDetailTabProps,
} from "@paperclipai/plugin-sdk/ui";
import type {
  DeliverableReview,
  ReviewActionLog,
  ReviewStatus,
} from "../types";

// =============================================================================
// Types
// =============================================================================

interface ReviewStatusData {
  review: DeliverableReview | null;
}

interface ReviewHistoryData {
  actions: ReviewActionLog[];
}

interface SubmitForReviewParams {
  issue_id: string;
  summary?: string;
  quality_score?: number;
  block_approval?: boolean;
}

interface ApproveParams {
  issue_id: string;
  comment?: string;
}

interface RejectParams {
  issue_id: string;
  comment: string;
}

// =============================================================================
// Utility
// =============================================================================

function getStatusColor(status: ReviewStatus): string {
  switch (status) {
    case "approved": return "#22c55e";
    case "rejected": return "#dc2626";
    case "pending_review": return "#f59e0b";
    default: return "#6b7280";
  }
}

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleString();
}

// =============================================================================
// Sub-components
// =============================================================================

function StatusBadge({ status }: { status: ReviewStatus }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "3px 10px",
        borderRadius: "9999px",
        fontSize: "12px",
        fontWeight: "bold",
        backgroundColor: getStatusColor(status),
        color: "white",
      }}
    >
      {status.replace("_", " ").toUpperCase()}
    </span>
  );
}

function ScoreBar({ score }: { score?: number }) {
  if (score === undefined) return null;
  const pct = score * 10;
  const color = score >= 7 ? "#22c55e" : score >= 4 ? "#f59e0b" : "#dc2626";
  return (
    <div style={{ marginTop: "6px" }}>
      <div style={{ fontSize: "12px", color: "#6b7280", marginBottom: "4px" }}>
        Quality Score: <strong>{score}/10</strong>
      </div>
      <div
        style={{
          height: "6px",
          borderRadius: "3px",
          backgroundColor: "#e5e7eb",
          width: "100%",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            backgroundColor: color,
            borderRadius: "3px",
            transition: "width 0.3s ease",
          }}
        />
      </div>
    </div>
  );
}

function ActionLogEntry({ entry }: { entry: ReviewActionLog }) {
  return (
    <div
      style={{
        padding: "8px 0",
        borderBottom: "1px solid #f3f4f6",
        fontSize: "13px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontWeight: "600" }}>{entry.action}</span>
        <span style={{ fontSize: "11px", color: "#9ca3af" }}>
          {formatTimestamp(entry.timestamp)}
        </span>
      </div>
      <div style={{ fontSize: "12px", color: "#6b7280", marginTop: "2px" }}>
        by <strong>{entry.reviewerName}</strong> ({entry.reviewer})
      </div>
      {entry.comment && (
        <div
          style={{
            marginTop: "4px",
            padding: "6px 8px",
            backgroundColor: "#f9fafb",
            borderRadius: "4px",
            fontSize: "12px",
            color: "#374151",
          }}
        >
          {entry.comment}
        </div>
      )}
      {entry.qualityScore !== undefined && (
        <div style={{ fontSize: "12px", color: "#6b7280", marginTop: "2px" }}>
          Score: {entry.qualityScore}/10
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Main Tab Component
// =============================================================================

export function QualityGateTab({
  context,
}: PluginDetailTabProps) {
  const issueId = context.entityId;

  const { data, loading, error, refresh } =
    usePluginData<ReviewStatusData>("review_status", {
      issueId,
    });

  const { data: historyData } =
    usePluginData<ReviewHistoryData>("review_history", {
      issueId,
    });

  const submitAction = usePluginAction("submit_for_review");
  const approveAction = usePluginAction("approve_deliverable");
  const rejectAction = usePluginAction("reject_deliverable");

  // Real-time updates
  usePluginStream<{ issueId: string; review: DeliverableReview }>(
    "review_updated",
  );

  const review = data?.review ?? null;
  const actionLog = historyData?.actions ?? [];

  const [summary, setSummary] = React.useState("");
  const [score, setScore] = React.useState(7);
  const [blockApproval, setBlockApproval] = React.useState(false);
  const [comment, setComment] = React.useState("");
  const [rejectReason, setRejectReason] = React.useState("");
  const [feedback, setFeedback] = React.useState<string | null>(null);

  function showFeedback(msg: string) {
    setFeedback(msg);
    setTimeout(() => setFeedback(null), 3000);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await (submitAction as (params: SubmitForReviewParams) => Promise<unknown>)({
        issue_id: issueId,
        summary,
        quality_score: score,
        block_approval: blockApproval,
      });
      refresh();
      setSummary("");
      setBlockApproval(false);
      showFeedback("Submitted for review.");
    } catch (err) {
      showFeedback(`Error: ${(err as Error).message}`);
    }
  }

  async function handleApprove() {
    try {
      await (approveAction as (params: ApproveParams) => Promise<unknown>)({
        issue_id: issueId,
        comment,
      });
      refresh();
      setComment("");
      showFeedback("Deliverable approved.");
    } catch (err) {
      showFeedback(`Error: ${(err as Error).message}`);
    }
  }

  async function handleReject(e: React.FormEvent) {
    e.preventDefault();
    if (!rejectReason.trim()) {
      showFeedback("A rejection reason is required.");
      return;
    }
    try {
      await (rejectAction as (params: RejectParams) => Promise<unknown>)({
        issue_id: issueId,
        comment: rejectReason,
      });
      refresh();
      setRejectReason("");
      showFeedback("Deliverable rejected.");
    } catch (err) {
      showFeedback(`Error: ${(err as Error).message}`);
    }
  }

  if (loading) {
    return <div style={{ padding: "16px", color: "#6b7280" }}>Loading…</div>;
  }

  if (error) {
    return (
      <div style={{ padding: "16px", color: "#dc2626" }}>
        Error: {error.message}
      </div>
    );
  }

  return (
    <div style={{ padding: "16px", maxWidth: "640px", fontFamily: "system-ui, sans-serif" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "16px",
        }}
      >
        <h2 style={{ margin: 0, fontSize: "16px", fontWeight: "bold" }}>
          Quality Gate
        </h2>
        {review && <StatusBadge status={review.status} />}
      </div>

      {/* Feedback toast */}
      {feedback && (
        <div
          style={{
            padding: "8px 12px",
            backgroundColor: "#dcfce7",
            border: "1px solid #86efac",
            borderRadius: "6px",
            marginBottom: "12px",
            fontSize: "13px",
            color: "#166534",
          }}
        >
          {feedback}
        </div>
      )}

      {/* Review summary */}
      {review && (
        <div
          style={{
            padding: "12px",
            backgroundColor: "#f9fafb",
            borderRadius: "8px",
            marginBottom: "16px",
            fontSize: "13px",
          }}
        >
          <div style={{ marginBottom: "4px" }}>
            <strong>Submitted:</strong> {formatTimestamp(review.submittedAt)}
          </div>
          {review.deliverableSummary && (
            <div style={{ marginBottom: "4px" }}>
              <strong>Summary:</strong> {review.deliverableSummary}
            </div>
          )}
          <ScoreBar score={review.qualityScore} />
          {review.blockApproval && (
            <div
              style={{
                marginTop: "6px",
                padding: "4px 8px",
                backgroundColor: "#fef3c7",
                borderRadius: "4px",
                fontSize: "12px",
                color: "#92400e",
              }}
            >
              ⚠ Agent flagged a known limitation
            </div>
          )}
        </div>
      )}

      {/* Submit form — always visible for pending */}
      {(!review || review.status === "pending_review") && (
        <form onSubmit={handleSubmit} style={{ marginBottom: "16px" }}>
          <div style={{ marginBottom: "10px" }}>
            <label
              style={{ display: "block", fontSize: "12px", fontWeight: "600", marginBottom: "4px" }}
            >
              Deliverable Summary
            </label>
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Describe what was delivered…"
              rows={3}
              style={{
                width: "100%",
                padding: "8px",
                borderRadius: "6px",
                border: "1px solid #d1d5db",
                fontSize: "13px",
                resize: "vertical",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "10px",
              marginBottom: "10px",
            }}
          >
            <div>
              <label
                style={{ display: "block", fontSize: "12px", fontWeight: "600", marginBottom: "4px" }}
              >
                Quality Score (0–10)
              </label>
              <input
                type="number"
                min={0}
                max={10}
                value={score}
                onChange={(e) => setScore(Number(e.target.value))}
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  borderRadius: "6px",
                  border: "1px solid #d1d5db",
                  fontSize: "13px",
                }}
              />
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                paddingTop: "20px",
              }}
            >
              <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px" }}>
                <input
                  type="checkbox"
                  checked={blockApproval}
                  onChange={(e) => setBlockApproval(e.target.checked)}
                />
                Block approval
              </label>
            </div>
          </div>

          <button
            type="submit"
            style={{
              width: "100%",
              padding: "8px 16px",
              borderRadius: "6px",
              border: "none",
              backgroundColor: "#3b82f6",
              color: "white",
              fontSize: "13px",
              fontWeight: "600",
              cursor: "pointer",
            }}
          >
            Submit for Review
          </button>
        </form>
      )}

      {/* Approve / Reject actions — visible when pending */}
      {review?.status === "pending_review" && (
        <div style={{ marginBottom: "16px" }}>
          {/* Approve */}
          <div style={{ marginBottom: "12px" }}>
            <label
              style={{ display: "block", fontSize: "12px", fontWeight: "600", marginBottom: "4px" }}
            >
              Approval Comment (optional)
            </label>
            <input
              type="text"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Add a note…"
              style={{
                width: "100%",
                padding: "6px 8px",
                borderRadius: "6px",
                border: "1px solid #d1d5db",
                fontSize: "13px",
                boxSizing: "border-box",
                marginBottom: "6px",
              }}
            />
            <button
              onClick={handleApprove}
              style={{
                width: "100%",
                padding: "8px 16px",
                borderRadius: "6px",
                border: "none",
                backgroundColor: "#22c55e",
                color: "white",
                fontSize: "13px",
                fontWeight: "600",
                cursor: "pointer",
              }}
            >
              Approve
            </button>
          </div>

          {/* Reject */}
          <form onSubmit={handleReject}>
            <label
              style={{ display: "block", fontSize: "12px", fontWeight: "600", marginBottom: "4px" }}
            >
              Rejection Reason (required)
            </label>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Describe what must be revised…"
              rows={2}
              required
              style={{
                width: "100%",
                padding: "6px 8px",
                borderRadius: "6px",
                border: "1px solid #d1d5db",
                fontSize: "13px",
                resize: "vertical",
                boxSizing: "border-box",
                marginBottom: "6px",
              }}
            />
            <button
              type="submit"
              style={{
                width: "100%",
                padding: "8px 16px",
                borderRadius: "6px",
                border: "1px solid #dc2626",
                backgroundColor: "white",
                color: "#dc2626",
                fontSize: "13px",
                fontWeight: "600",
                cursor: "pointer",
              }}
            >
              Reject &amp; Request Changes
            </button>
          </form>
        </div>
      )}

      {/* Action log */}
      {actionLog.length > 0 && (
        <div>
          <h3
            style={{
              fontSize: "13px",
              fontWeight: "bold",
              marginBottom: "8px",
              color: "#374151",
            }}
          >
            Review History
          </h3>
          <div
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: "8px",
              padding: "8px 12px",
            }}
          >
            {[...actionLog].reverse().map((entry, i) => (
              <ActionLogEntry key={i} entry={entry} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
