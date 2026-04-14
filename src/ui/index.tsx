import * as React from "react";
import {
  usePluginAction,
  usePluginData,
  usePluginStream,
  type PluginDetailTabProps,
} from "@paperclipai/plugin-sdk/ui";
import type {
  DeliverableReview,
  QualityCheck,
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
// Constants
// =============================================================================

function getStatusMeta(status: ReviewStatus): {
  label: string;
  color: string;
  bg: string;
  icon: string;
} {
  switch (status) {
    case "approved":
      return { label: "Approved", color: "#166534", bg: "#dcfce7", icon: "✅" };
    case "rejected":
      return { label: "Rejected", color: "#991b1b", bg: "#fef2f2", icon: "❌" };
    case "pending_review":
      return { label: "In Review", color: "#92400e", bg: "#fef3c7", icon: "⏳" };
    default:
      return { label: status, color: "#374151", bg: "#f3f4f6", icon: "—" };
  }
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// =============================================================================
// Score display
// =============================================================================

function ScoreBar({ score, label }: { score: number; label: string }) {
  const pct = score * 10;
  const color = score >= 7 ? "#22c55e" : score >= 5 ? "#f59e0b" : "#dc2626";
  return (
    <div style={{ marginBottom: "8px" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "12px",
          color: "#6b7280",
          marginBottom: "3px",
        }}
      >
        <span>{label}</span>
        <strong style={{ color }}>{score}/10</strong>
      </div>
      <div
        style={{
          height: "5px",
          borderRadius: "3px",
          backgroundColor: "#e5e7eb",
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

function CategoryChecks({ checks }: { checks: QualityCheck[] }) {
  if (!checks || checks.length === 0) return null;
  return (
    <div style={{ marginBottom: "12px" }}>
      {checks.map((check) => (
        <div
          key={check.category}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "8px",
            marginBottom: "6px",
            fontSize: "12px",
          }}
        >
          <span
            style={{
              color: check.passed ? "#22c55e" : "#dc2626",
              flexShrink: 0,
              marginTop: "1px",
            }}
          >
            {check.passed ? "✅" : "❌"}
          </span>
          <div style={{ flex: 1 }}>
            <span style={{ fontWeight: "600", color: "#374151", textTransform: "capitalize" }}>
              {check.category.replace("_", " ")}
            </span>
            <span style={{ color: "#6b7280", marginLeft: "6px" }}>
              {check.score}/10
            </span>
            {check.message && (
              <div style={{ color: "#9ca3af", fontSize: "11px", marginTop: "1px" }}>
                {check.message}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// =============================================================================
// Action log
// =============================================================================

function ActionLogEntry({ entry }: { entry: ReviewActionLog }) {
  return (
    <div
      style={{
        padding: "10px 0",
        borderBottom: "1px solid #f3f4f6",
        fontSize: "13px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
        }}
      >
        <div style={{ fontWeight: "600", color: "#111827" }}>{entry.action}</div>
        <div
          style={{
            fontSize: "11px",
            color: "#9ca3af",
            marginLeft: "8px",
            flexShrink: 0,
          }}
        >
          {formatTimestamp(entry.timestamp)}
        </div>
      </div>
      <div style={{ fontSize: "12px", color: "#6b7280", marginTop: "2px" }}>
        by <strong>{entry.reviewerName}</strong>
        {entry.auto && (
          <span
            style={{
              marginLeft: "6px",
              padding: "1px 6px",
              backgroundColor: "#f3f4f6",
              borderRadius: "10px",
              fontSize: "10px",
            }}
          >
            AUTO
          </span>
        )}
      </div>
      {entry.comment && (
        <div
          style={{
            marginTop: "6px",
            padding: "6px 10px",
            backgroundColor: "#f9fafb",
            borderRadius: "6px",
            fontSize: "12px",
            color: "#374151",
            borderLeft: "3px solid #d1d5db",
          }}
        >
          {entry.comment}
        </div>
      )}
      {entry.qualityScore !== undefined && (
        <div style={{ marginTop: "4px" }}>
          <ScoreBar score={entry.qualityScore} label="Quality Score" />
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Loading skeleton
// =============================================================================

function Skeleton() {
  return (
    <div style={{ padding: "16px" }}>
      {[80, 60, 90, 70, 50].map((w, i) => (
        <div
          key={i}
          style={{
            height: "14px",
            width: `${w}%`,
            backgroundColor: "#e5e7eb",
            borderRadius: "7px",
            marginBottom: "10px",
            animation: "pulse 1.5s infinite",
          }}
        />
      ))}
    </div>
  );
}

// =============================================================================
// Toast feedback
// =============================================================================

function Toast({ message, type }: { message: string; type: "success" | "error" }) {
  const colors =
    type === "success"
      ? { bg: "#dcfce7", border: "#86efac", text: "#166534" }
      : { bg: "#fef2f2", border: "#fca5a5", text: "#991b1b" };
  return (
    <div
      style={{
        padding: "8px 12px",
        backgroundColor: colors.bg,
        border: `1px solid ${colors.border}`,
        borderRadius: "8px",
        fontSize: "13px",
        color: colors.text,
        marginBottom: "12px",
      }}
    >
      {message}
    </div>
  );
}

// =============================================================================
// Main Tab Component
// =============================================================================

export function QualityGateTab({ context }: PluginDetailTabProps) {
  const issueId = context.entityId;

  const {
    data: statusData,
    loading: statusLoading,
    error: statusError,
    refresh: refreshStatus,
  } = usePluginData<ReviewStatusData>("review_status", { issueId });

  const { data: historyData } = usePluginData<ReviewHistoryData>(
    "review_history",
    { issueId },
  );

  const submitAction = usePluginAction("submit_for_review");
  const approveAction = usePluginAction("approve_deliverable");
  const rejectAction = usePluginAction("reject_deliverable");

  // Subscribe to real-time review updates
  usePluginStream<{ issueId: string; review: DeliverableReview }>("review_updated");

  const review = statusData?.review ?? null;
  const actionLog = historyData?.actions ?? [];

  // Form state
  const [summary, setSummary] = React.useState("");
  const [score, setScore] = React.useState(7);
  const [blockApproval, setBlockApproval] = React.useState(false);
  const [comment, setComment] = React.useState("");
  const [rejectReason, setRejectReason] = React.useState("");
  const [toast, setToast] = React.useState<{ message: string; type: "success" | "error" } | null>(null);
  const [activeSection, setActiveSection] = React.useState<"submit" | "review" | "history">("review");

  function showToast(msg: string, type: "success" | "error" = "success") {
    setToast({ message: msg, type });
    setTimeout(() => setToast(null), 3500);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await (submitAction as (p: SubmitForReviewParams) => Promise<unknown>)({
        issue_id: issueId,
        summary,
        quality_score: score,
        block_approval: blockApproval,
      });
      refreshStatus();
      setSummary("");
      setBlockApproval(false);
      showToast("Submitted for review.");
    } catch (err) {
      showToast(`Error: ${(err as Error).message}`, "error");
    }
  }

  async function handleApprove() {
    try {
      await (approveAction as (p: ApproveParams) => Promise<unknown>)({
        issue_id: issueId,
        comment,
      });
      refreshStatus();
      setComment("");
      showToast("Deliverable approved.");
    } catch (err) {
      showToast(`Error: ${(err as Error).message}`, "error");
    }
  }

  async function handleReject(e: React.FormEvent) {
    e.preventDefault();
    if (!rejectReason.trim()) {
      showToast("A rejection reason is required.", "error");
      return;
    }
    try {
      await (rejectAction as (p: RejectParams) => Promise<unknown>)({
        issue_id: issueId,
        comment: rejectReason,
      });
      refreshStatus();
      setRejectReason("");
      showToast("Changes requested — issue returned to agent.");
    } catch (err) {
      showToast(`Error: ${(err as Error).message}`, "error");
    }
  }

  if (statusLoading) return <Skeleton />;

  if (statusError) {
    return (
      <div style={{ padding: "16px", color: "#dc2626", fontSize: "13px" }}>
        Failed to load: {statusError.message}
      </div>
    );
  }

  const statusMeta = review ? getStatusMeta(review.status) : null;

  return (
    <div
      style={{
        padding: "16px",
        maxWidth: "680px",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      }}
    >
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>

      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "16px",
          paddingBottom: "12px",
          borderBottom: "1px solid #e5e7eb",
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: "15px",
            fontWeight: "700",
            color: "#111827",
          }}
        >
          Quality Gate
        </h2>
        {statusMeta && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              padding: "4px 10px",
              borderRadius: "9999px",
              fontSize: "12px",
              fontWeight: "700",
              backgroundColor: statusMeta.bg,
              color: statusMeta.color,
            }}
          >
            {statusMeta.icon} {statusMeta.label}
          </span>
        )}
      </div>

      {/* Toast */}
      {toast && <Toast message={toast.message} type={toast.type} />}

      {/* No review yet */}
      {!review && (
        <div
          style={{
            padding: "24px",
            textAlign: "center",
            backgroundColor: "#f9fafb",
            borderRadius: "10px",
            border: "1px dashed #d1d5db",
            marginBottom: "16px",
          }}
        >
          <div style={{ fontSize: "32px", marginBottom: "8px" }}>🚦</div>
          <div
            style={{ fontWeight: "600", color: "#374151", marginBottom: "4px" }}
          >
            No deliverable submitted yet
          </div>
          <div style={{ fontSize: "13px", color: "#6b7280" }}>
            Submit a deliverable below to begin the quality review process.
          </div>
        </div>
      )}

      {/* Review summary — shown when review exists */}
      {review && (
        <div
          style={{
            padding: "14px",
            backgroundColor: "#f9fafb",
            borderRadius: "10px",
            marginBottom: "16px",
            fontSize: "13px",
            border: "1px solid #e5e7eb",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: "8px",
            }}
          >
            <div>
              <span style={{ color: "#6b7280", fontSize: "12px" }}>
                Submitted{" "}
              </span>
              <span style={{ fontWeight: "600", color: "#374151" }}>
                {formatTimestamp(review.submittedAt)}
              </span>
            </div>
            {review.qualityScore !== undefined && (
              <div
                style={{
                  fontWeight: "700",
                  fontSize: "20px",
                  color:
                    review.qualityScore >= 7
                      ? "#22c55e"
                      : review.qualityScore >= 5
                      ? "#f59e0b"
                      : "#dc2626",
                }}
              >
                {review.qualityScore}
                <span style={{ fontSize: "12px", color: "#9ca3af" }}>/10</span>
              </div>
            )}
          </div>

          {review.deliverableSummary && (
            <div
              style={{
                color: "#374151",
                marginBottom: "8px",
                lineHeight: "1.5",
              }}
            >
              {review.deliverableSummary}
            </div>
          )}

          {/* Per-category score breakdown */}
          {review.qualityChecks && review.qualityChecks.length > 0 && (
            <CategoryChecks checks={review.qualityChecks} />
          )}

          {review.blockApproval && (
            <div
              style={{
                padding: "6px 10px",
                backgroundColor: "#fef3c7",
                borderRadius: "6px",
                fontSize: "12px",
                color: "#92400e",
                fontWeight: "600",
              }}
            >
              ⚠️ Agent flagged a known limitation — review required
            </div>
          )}

          {review.evaluationSummary && (
            <div
              style={{
                marginTop: "8px",
                fontSize: "12px",
                color: "#6b7280",
                fontStyle: "italic",
              }}
            >
              {review.evaluationSummary}
            </div>
          )}
        </div>
      )}

      {/* Tabs: Submit / Review / History */}
      {review && (
        <div
          style={{
            display: "flex",
            gap: "4px",
            marginBottom: "12px",
            borderBottom: "1px solid #e5e7eb",
          }}
        >
          {(["submit", "review", "history"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveSection(tab)}
              style={{
                padding: "6px 14px",
                border: "none",
                background: "none",
                fontSize: "13px",
                fontWeight: "600",
                cursor: "pointer",
                borderBottom:
                  activeSection === tab
                    ? "2px solid #3b82f6"
                    : "2px solid transparent",
                color:
                  activeSection === tab ? "#3b82f6" : "#6b7280",
                transition: "all 0.15s",
              }}
            >
              {tab === "submit"
                ? "Resubmit"
                : tab === "review"
                ? "Review"
                : "History"}
            </button>
          ))}
        </div>
      )}

      {/* ---- Submit / Resubmit section ---- */}
      {(!review || review.status === "pending_review" || activeSection === "submit") && (
        <form onSubmit={handleSubmit} style={{ marginBottom: "16px" }}>
          <div style={{ marginBottom: "12px" }}>
            <label style={labelStyle}>Deliverable Summary</label>
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Describe what was delivered — changes made, files modified, decisions taken…"
              rows={3}
              style={{ ...inputStyle, resize: "vertical" }}
            />
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "12px",
              marginBottom: "12px",
            }}
          >
            <div>
              <label style={labelStyle}>Quality Score (0–10)</label>
              <input
                type="number"
                min={0}
                max={10}
                step={0.5}
                value={score}
                onChange={(e) => setScore(Number(e.target.value))}
                style={inputStyle}
              />
              <ScoreBar score={score} label="" />
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "flex-end",
              }}
            >
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  fontSize: "13px",
                  fontWeight: "600",
                  color: "#374151",
                  cursor: "pointer",
                  marginBottom: "8px",
                }}
              >
                <input
                  type="checkbox"
                  checked={blockApproval}
                  onChange={(e) => setBlockApproval(e.target.checked)}
                  style={{ width: "16px", height: "16px" }}
                />
                Block approval
              </label>
              <div
                style={{
                  fontSize: "11px",
                  color: "#9ca3af",
                  lineHeight: "1.4",
                }}
              >
                Flag a known limitation that should prevent automatic approval
              </div>
            </div>
          </div>

          <button type="submit" style={primaryButtonStyle}>
            🚦 Submit for Review
          </button>
        </form>
      )}

      {/* ---- Review actions (approve/reject) — only when pending ---- */}
      {review?.status === "pending_review" && activeSection === "review" && (
        <div style={{ marginBottom: "16px" }}>
          {/* Approve */}
          <div
            style={{
              padding: "14px",
              backgroundColor: "#f0fdf4",
              borderRadius: "10px",
              border: "1px solid #bbf7d0",
              marginBottom: "12px",
            }}
          >
            <label style={labelStyle}>Approval Note (optional)</label>
            <input
              type="text"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Add a note for the record…"
              style={{ ...inputStyle, marginBottom: "8px" }}
            />
            <button
              onClick={handleApprove}
              style={{ ...primaryButtonStyle, backgroundColor: "#22c55e" }}
            >
              ✅ Approve Deliverable
            </button>
          </div>

          {/* Reject */}
          <div
            style={{
              padding: "14px",
              backgroundColor: "#fef2f2",
              borderRadius: "10px",
              border: "1px solid #fecaca",
            }}
          >
            <form onSubmit={handleReject}>
              <label style={labelStyle}>
                Rejection Reason <span style={{ color: "#dc2626" }}>*</span>
              </label>
              <textarea
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Describe what must be revised before approval…"
                rows={2}
                required
                style={{ ...inputStyle, resize: "vertical", marginBottom: "8px" }}
              />
              <button
                type="submit"
                style={{
                  width: "100%",
                  padding: "10px",
                  borderRadius: "8px",
                  border: "1px solid #dc2626",
                  backgroundColor: "white",
                  color: "#dc2626",
                  fontSize: "13px",
                  fontWeight: "700",
                  cursor: "pointer",
                }}
              >
                ❌ Reject &amp; Request Changes
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Already decided */}
      {review && (review.status === "approved" || review.status === "rejected") && (
        <div
          style={{
            padding: "14px",
            backgroundColor: "#f9fafb",
            borderRadius: "10px",
            textAlign: "center",
            fontSize: "13px",
            color: "#6b7280",
            marginBottom: "16px",
            border: "1px solid #e5e7eb",
          }}
        >
          This deliverable has been {review.status}. See the history below for
          details.{" "}
          {review.status === "rejected" && (
            <button
              onClick={() => setActiveSection("submit")}
              style={{
                display: "block",
                margin: "10px auto 0",
                padding: "6px 16px",
                borderRadius: "6px",
                border: "1px solid #d1d5db",
                backgroundColor: "white",
                fontSize: "12px",
                fontWeight: "600",
                cursor: "pointer",
              }}
            >
              Resubmit for Review
            </button>
          )}
        </div>
      )}

      {/* History */}
      {actionLog.length > 0 && (
        <div>
          <h3
            style={{
              fontSize: "13px",
              fontWeight: "700",
              color: "#374151",
              marginBottom: "8px",
            }}
          >
            Review History
          </h3>
          <div
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: "10px",
              padding: "4px 14px",
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

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "12px",
  fontWeight: "600",
  color: "#374151",
  marginBottom: "5px",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: "8px",
  border: "1px solid #d1d5db",
  fontSize: "13px",
  boxSizing: "border-box",
  fontFamily: "inherit",
};

const primaryButtonStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 16px",
  borderRadius: "8px",
  border: "none",
  backgroundColor: "#3b82f6",
  color: "white",
  fontSize: "13px",
  fontWeight: "700",
  cursor: "pointer",
};
