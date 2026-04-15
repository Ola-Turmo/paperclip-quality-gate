import React, { useCallback, useEffect, useState } from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginDetailTabProps,
} from "@paperclipai/plugin-sdk/ui";
import type { DeliverableReview, QualityGateSettings, ReviewAction } from "../types.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface ReviewStatusData {
  review: DeliverableReview;
  issue?: { id: string; title: string; status: string };
}

interface ConfigData {
  minQualityScore: number;
  blockThreshold: number;
  autoRejectBelow: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function statusColor(status: string): string {
  switch (status) {
    case "approved":           return "#22c55e";
    case "pending_review":     return "#3b82f6";
    case "needs_human_review": return "#f59e0b";
    case "auto_rejected":     return "#ef4444";
    case "rejected":          return "#ef4444";
    default:                   return "#6b7280";
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "approved":           return "✅ Approved";
    case "pending_review":     return "⏳ Pending Review";
    case "needs_human_review": return "🛡️ Needs Human Review";
    case "auto_rejected":      return "⚠️ Auto-Rejected";
    case "rejected":           return "❌ Rejected";
    default:                   return status;
  }
}

function formatDate(iso: string): string {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function categoryBadge(category: string): React.ReactNode {
  const colors: Record<string, string> = {
    passed:              "#22c55e",
    needs_human_review:  "#f59e0b",
    blocked:             "#ef4444",
    auto_rejected:       "#dc2626",
    rejected:            "#ef4444",
    none:                "#6b7280",
  };
  const c = colors[category] ?? "#6b7280";
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: 4,
      background: c + "22",
      color: c,
      fontSize: 12,
      fontWeight: 500,
      fontFamily: "monospace",
    }}>
      {category}
    </span>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ReviewChecks({ checks }: { checks: DeliverableReview["checks"] }) {
  if (!checks || checks.length === 0) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <h4 style={{ margin: "0 0 8px", fontSize: 13, color: "#9ca3af" }}>Quality Checks</h4>
      {checks.map((check) => (
        <div key={check.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 6, fontSize: 13 }}>
          <span style={{ fontSize: 14 }}>{check.passed ? "✅" : "❌"}</span>
          <div>
            <strong>{check.name}</strong>
            <div style={{ color: "#9ca3af", fontSize: 12 }}>{check.details}</div>
            <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "monospace" }}>
              score: {check.score}/10
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function HistoryTimeline({ history }: { history: ReviewAction[] }) {
  if (!history || history.length === 0) return null;
  return (
    <div style={{ marginTop: 16 }}>
      <h4 style={{ margin: "0 0 8px", fontSize: 13, color: "#9ca3af" }}>History</h4>
      <div style={{ borderLeft: "2px solid #374151", paddingLeft: 12, marginLeft: 4 }}>
        {[...history].reverse().map((entry, i) => (
          <div key={i} style={{ marginBottom: 10, fontSize: 13 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ fontWeight: 500 }}>{entry.action}</span>
              <span style={{ color: "#6b7280", fontSize: 12 }}>
                by {entry.reviewerName} · {formatDate(entry.createdAt)}
              </span>
            </div>
            {entry.comment && (
              <div style={{
                marginTop: 2,
                padding: "4px 8px",
                background: "#1f2937",
                borderRadius: 4,
                fontSize: 12,
                color: "#d1d5db",
              }}>
                {entry.comment}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ScoreBar({ score }: { score: number }) {
  const pct = (score / 10) * 100;
  const color = score >= 7 ? "#22c55e" : score >= 5 ? "#f59e0b" : "#ef4444";
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: "#9ca3af" }}>Quality Score</span>
        <span style={{ fontSize: 13, fontWeight: 600, color }}>{score}/10</span>
      </div>
      <div style={{ height: 6, background: "#374151", borderRadius: 3 }}>
        <div style={{
          height: "100%", width: `${pct}%`, background: color,
          borderRadius: 3, transition: "width 0.3s",
        }} />
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function QualityGateTab({ context }: PluginDetailTabProps) {
  const { entityId: issueId, companyId } = context;
  const submitAction = usePluginAction("quality_gate.submit");
  const approveAction = usePluginAction("quality_gate.approve");
  const rejectAction = usePluginAction("quality_gate.reject");
  const reviewData = usePluginData("quality_gate.review", { issueId }) as unknown as ReviewStatusData | null;
  const config = usePluginData("quality_gate.config") as unknown as ConfigData | null;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  // Refresh when issue changes
  useEffect(() => {
    setError(null);
    setResult(null);
  }, [issueId]);

  const handleSubmit = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await submitAction({ issue_id: issueId }) as { ok: boolean; error?: string; message?: string };
      if (r.ok) {
        setResult(r.message ?? "Submitted for review.");
      } else {
        setError(r.error ?? "Submission failed.");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [issueId, submitAction]);

  const handleApprove = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await approveAction({ issue_id: issueId, comment: "" }) as { ok: boolean; error?: string; message?: string };
      if (r.ok) {
        setResult(r.message ?? "Approved.");
      } else {
        setError(r.error ?? "Approval failed.");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [issueId, approveAction]);

  const handleReject = useCallback(async () => {
    const comment = window.prompt("Reason for rejection (required):");
    if (!comment) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await rejectAction({ issue_id: issueId, comment }) as { ok: boolean; error?: string; message?: string };
      if (r.ok) {
        setResult(r.message ?? "Rejected.");
      } else {
        setError(r.error ?? "Rejection failed.");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [issueId, rejectAction]);

  const review = reviewData?.review;
  const btnStyle = (bg: string): React.CSSProperties => ({
    flex: 1,
    padding: "9px 12px",
    background: loading ? "#374151" : bg,
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 500,
    cursor: loading ? "not-allowed" : "pointer",
  });

  if (!review && !config) {
    return (
      <div style={{ padding: 20, color: "#9ca3af", fontFamily: "system-ui" }}>
        Loading quality gate…
      </div>
    );
  }

  return (
    <div style={{
      padding: 20, fontFamily: "system-ui, sans-serif",
      color: "#f3f4f6", background: "#111827", minHeight: "100%",
    }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Quality Gate</h2>
          <p style={{ margin: "4px 0 0", color: "#9ca3af", fontSize: 13 }}>
            Issue: <code style={{ color: "#60a5fa" }}>{issueId}</code>
          </p>
        </div>
        {review && (
          <div style={{ textAlign: "right" }}>
            <div style={{
              display: "inline-block",
              padding: "4px 12px",
              borderRadius: 6,
              background: statusColor(review.status) + "22",
              color: statusColor(review.status),
              fontWeight: 600, fontSize: 14,
            }}>
              {statusLabel(review.status)}
            </div>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div style={{
          padding: "10px 14px", background: "#ef444422",
          border: "1px solid #ef4444", borderRadius: 6,
          color: "#fca5a5", fontSize: 13, marginBottom: 12,
        }}>
          {error}
        </div>
      )}

      {/* Result */}
      {result && (
        <div style={{
          padding: "10px 14px", background: "#22c55e22",
          border: "1px solid #22c55e", borderRadius: 6,
          color: "#86efac", fontSize: 13, marginBottom: 12,
        }}>
          {result}
        </div>
      )}

      {/* No review yet */}
      {!review && (
        <div>
          <div style={{
            padding: "24px", background: "#1f2937",
            borderRadius: 8, textAlign: "center", marginBottom: 16,
          }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🔍</div>
            <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>No review yet</h3>
            <p style={{ margin: 0, color: "#9ca3af", fontSize: 13 }}>
              Submit the deliverable to start the quality gate review process.
            </p>
          </div>
          <button onClick={handleSubmit} disabled={loading} style={{ ...btnStyle("#3b82f6"), width: "100%" }}>
            {loading ? "Submitting…" : "Submit for Review"}
          </button>
        </div>
      )}

      {/* Review exists */}
      {review && (
        <div>
          <div style={{ background: "#1f2937", borderRadius: 8, padding: 16, marginBottom: 12 }}>
            <ScoreBar score={review.qualityScore} />
            <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
              {categoryBadge(review.category)}
              <span style={{ fontSize: 12, color: "#6b7280" }}>
                by {review.submitterName} · {formatDate(review.createdAt)}
              </span>
            </div>
            {review.evaluationSummary && (
              <p style={{
                margin: "12px 0 0", padding: "8px 10px",
                background: "#111827", borderRadius: 4, fontSize: 13,
                color: "#d1d5db", borderLeft: "3px solid #3b82f6",
              }}>
                {review.evaluationSummary}
              </p>
            )}
            <ReviewChecks checks={review.checks} />
          </div>

          {config && (
            <div style={{
              background: "#1f2937", borderRadius: 8, padding: "12px 16px",
              marginBottom: 12, fontSize: 12, color: "#6b7280", fontFamily: "monospace",
            }}>
              Thresholds: min={config.minQualityScore} · block≤{config.blockThreshold} · auto-reject&lt;{config.autoRejectBelow}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {review.status !== "approved" && (
              <button onClick={handleApprove} disabled={loading} style={btnStyle("#22c55e")}>
                ✅ Approve
              </button>
            )}
            {review.status !== "rejected" && review.status !== "auto_rejected" && (
              <button onClick={handleReject} disabled={loading} style={btnStyle("#ef4444")}>
                ❌ Reject
              </button>
            )}
            <button onClick={handleSubmit} disabled={loading} style={btnStyle("#3b82f6")}>
              🔄 Resubmit
            </button>
          </div>

          <HistoryTimeline history={review.history} />
        </div>
      )}
    </div>
  );
}

export default QualityGateTab;
