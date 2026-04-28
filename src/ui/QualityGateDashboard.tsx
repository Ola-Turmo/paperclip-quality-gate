import React, { useMemo, useState } from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";
import type {
  QualityTrendsData,
  ReviewQueueData,
  ReviewQueueItem,
} from "../types.js";

function shellStyle(): React.CSSProperties {
  return {
    padding: 24,
    minHeight: "100%",
    background: "linear-gradient(180deg, #020617 0%, #0f172a 100%)",
    color: "#e2e8f0",
    fontFamily: "Inter, system-ui, sans-serif",
  };
}

function panelStyle(): React.CSSProperties {
  return {
    background: "#111827",
    border: "1px solid #1f2937",
    borderRadius: 16,
    padding: 16,
    boxShadow: "0 12px 30px rgba(15, 23, 42, 0.2)",
  };
}

function inputStyle(): React.CSSProperties {
  return {
    width: "100%",
    boxSizing: "border-box",
    borderRadius: 10,
    border: "1px solid #334155",
    background: "#020617",
    color: "#e2e8f0",
    padding: "10px 12px",
    fontSize: 13,
  };
}

function buttonStyle(
  background: string,
  disabled?: boolean,
): React.CSSProperties {
  return {
    border: "none",
    borderRadius: 10,
    padding: "10px 14px",
    background: disabled ? "#334155" : background,
    color: "white",
    fontWeight: 700,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function metricTone(value: number): string {
  if (value >= 7) return "#22c55e";
  if (value >= 5) return "#f59e0b";
  return "#ef4444";
}

function statusLabel(item: ReviewQueueItem): string {
  if (item.approvalState === "released") return "Released";
  if (item.approvalState === "approved_hold") return "Approved + hold";
  if (item.status === "auto_rejected") return "Auto-rejected";
  if (item.status === "rejected") return "Revision requested";
  if (item.status === "escalated") return "Escalated";
  return "Needs review";
}

function statusTone(item: ReviewQueueItem): { fg: string; bg: string } {
  if (item.approvalState === "released")
    return { fg: "#34d399", bg: "rgba(16,185,129,0.15)" };
  if (item.approvalState === "approved_hold")
    return { fg: "#93c5fd", bg: "rgba(59,130,246,0.15)" };
  if (item.status === "auto_rejected" || item.status === "rejected")
    return { fg: "#fca5a5", bg: "rgba(239,68,68,0.15)" };
  if (item.status === "escalated")
    return { fg: "#fbbf24", bg: "rgba(251,191,36,0.15)" };
  return { fg: "#facc15", bg: "rgba(250,204,21,0.15)" };
}

function formatDate(value: string): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function matchesFilter(item: ReviewQueueItem, filter: string): boolean {
  switch (filter) {
    case "pending":
      return (
        item.status === "pending_review" || item.status === "needs_human_review"
      );
    case "approved_hold":
      return item.approvalState === "approved_hold";
    case "released":
      return item.approvalState === "released";
    case "revision":
      return item.status === "rejected" || item.status === "auto_rejected";
    case "escalated":
      return item.status === "escalated" || item.approvalState === "escalated";
    case "high_risk":
      return item.topRiskLevel === "high" || item.topRiskLevel === "critical";
    default:
      return true;
  }
}

function MetricCard({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: string;
  hint?: string;
}) {
  return (
    <div style={{ ...panelStyle(), minWidth: 0 }}>
      <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, color: tone ?? "#f8fafc" }}>
        {value}
      </div>
      {hint ? (
        <div style={{ marginTop: 4, fontSize: 12, color: "#64748b" }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export function QualityGateDashboard({ context }: PluginPageProps) {
  const companyId = context.companyId ?? "";
  const queueQuery = usePluginData<ReviewQueueData>("quality_gate.queue", {
    companyId,
  });
  const trendsQuery = usePluginData<QualityTrendsData>("quality_gate.trends", {
    companyId,
  });
  const bulkApprove = usePluginAction("quality_gate.bulk_approve");
  const bulkReject = usePluginAction("quality_gate.bulk_reject");

  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [bulkComment, setBulkComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  const filteredItems = useMemo(() => {
    const items = queueQuery.data?.items ?? [];
    const query = search.trim().toLowerCase();
    return items.filter((item) => {
      if (!matchesFilter(item, filter)) return false;
      if (!query) return true;
      const haystack = [
        item.issueId,
        item.title,
        item.headline,
        item.assignedTo ?? "",
        item.topRiskLabel ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [filter, search, queueQuery.data?.items]);

  const summary = queueQuery.data?.summary;
  const agentTrends = trendsQuery.data?.agents ?? [];

  async function refreshAll() {
    await Promise.all([queueQuery.refresh(), trendsQuery.refresh()]);
  }

  async function runBulkAction(
    action: () => Promise<unknown>,
    success: string,
  ) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await action();
      const payload = result as {
        ok?: boolean;
        error?: string;
        message?: string;
      };
      if (payload?.ok === false) {
        setError(payload.error ?? "Bulk action failed.");
      } else {
        setMessage(payload?.message ?? success);
        setSelected([]);
        await refreshAll();
      }
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : String(actionError),
      );
    } finally {
      setBusy(false);
    }
  }

  if (!companyId) {
    return (
      <div style={shellStyle()}>
        Open this page within a company context to load the review queue.
      </div>
    );
  }

  return (
    <div style={shellStyle()}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
          marginBottom: 18,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 12,
              textTransform: "uppercase",
              letterSpacing: 1.2,
              color: "#38bdf8",
              fontWeight: 700,
            }}
          >
            Quality Gate queue
          </div>
          <h1 style={{ margin: "6px 0 8px", fontSize: 32, lineHeight: 1.08 }}>
            Board-level reviewer inbox for Paperclip deliverables
          </h1>
          <div style={{ color: "#94a3b8", fontSize: 14, maxWidth: 820 }}>
            Triages every evidence package across the company into one release
            workbench: review, hold, revise, escalate, or bulk-release with a
            full audit trail.
          </div>
        </div>
        <div style={{ ...panelStyle(), minWidth: 260 }}>
          <div
            style={{
              fontSize: 12,
              color: "#94a3b8",
              textTransform: "uppercase",
              letterSpacing: 1.1,
            }}
          >
            Queue health
          </div>
          <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6 }}>
            {summary?.pendingReviews ?? 0}
          </div>
          <div style={{ color: "#94a3b8", fontSize: 13 }}>
            packages currently waiting for reviewer action
          </div>
        </div>
      </div>

      {error ? (
        <div
          style={{
            ...panelStyle(),
            borderColor: "rgba(248,113,113,0.4)",
            color: "#fecaca",
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      ) : null}
      {message ? (
        <div
          style={{
            ...panelStyle(),
            borderColor: "rgba(74,222,128,0.4)",
            color: "#bbf7d0",
            marginBottom: 16,
          }}
        >
          {message}
        </div>
      ) : null}

      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          marginBottom: 16,
        }}
      >
        <MetricCard
          label="Pending review"
          value={String(summary?.pendingReviews ?? 0)}
          hint="Awaiting approve / hold / revise / escalate"
        />
        <MetricCard
          label="Approved + hold"
          value={String(summary?.approvedHoldReviews ?? 0)}
          hint="Approved but not yet released"
        />
        <MetricCard
          label="Released"
          value={String(summary?.releasedReviews ?? 0)}
          hint="Audit trail complete"
          tone="#34d399"
        />
        <MetricCard
          label="High-risk"
          value={String(summary?.highRiskReviews ?? 0)}
          hint="Contains high or critical risk flags"
          tone="#f87171"
        />
        <MetricCard
          label="Avg decision score"
          value={`${summary?.averageDecisionScore ?? 0}/10`}
          hint="Thresholds act on decision score"
          tone={metricTone(summary?.averageDecisionScore ?? 0)}
        />
        <MetricCard
          label="Unassigned pending"
          value={String(summary?.unassignedPendingReviews ?? 0)}
          hint="Needs a named reviewer owner"
        />
      </div>

      <div
        style={{ display: "grid", gap: 16, gridTemplateColumns: "1.5fr 1fr" }}
      >
        <div style={{ display: "grid", gap: 16 }}>
          <div style={panelStyle()}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
                marginBottom: 12,
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: 12,
                    color: "#38bdf8",
                    fontWeight: 700,
                    textTransform: "uppercase",
                  }}
                >
                  Review queue
                </div>
                <h2 style={{ margin: "4px 0 0", fontSize: 22 }}>
                  Prioritize the next release decisions
                </h2>
              </div>
              <div style={{ color: "#94a3b8", fontSize: 13 }}>
                {filteredItems.length} visible · {selected.length} selected
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gap: 10,
                gridTemplateColumns: "1.2fr 180px 160px",
              }}
            >
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search issue, risk, owner…"
                style={inputStyle()}
              />
              <select
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                style={inputStyle()}
              >
                <option value="all">All reviews</option>
                <option value="pending">Needs review</option>
                <option value="approved_hold">Approved + hold</option>
                <option value="released">Released</option>
                <option value="revision">Revision queue</option>
                <option value="escalated">Escalated</option>
                <option value="high_risk">High risk</option>
              </select>
              <button
                disabled={queueQuery.loading}
                onClick={() => refreshAll()}
                style={buttonStyle("#334155", queueQuery.loading)}
              >
                Refresh queue
              </button>
            </div>

            <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
              {queueQuery.loading && !queueQuery.data ? (
                <div style={{ color: "#94a3b8" }}>Loading review queue…</div>
              ) : null}
              {filteredItems.length === 0 && !queueQuery.loading ? (
                <div style={{ color: "#94a3b8" }}>
                  No review packages match the current filters.
                </div>
              ) : null}
              {filteredItems.map((item) => {
                const tone = statusTone(item);
                const checked = selected.includes(item.issueId);
                return (
                  <label
                    key={item.reviewId}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "24px 1.6fr 0.8fr 0.8fr 0.7fr",
                      gap: 12,
                      alignItems: "center",
                      border: "1px solid #1e293b",
                      borderRadius: 14,
                      padding: 12,
                      background: checked ? "rgba(59,130,246,0.08)" : "#020617",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setSelected((current) =>
                          checked
                            ? current.filter((value) => value !== item.issueId)
                            : [...current, item.issueId],
                        )
                      }
                    />
                    <div>
                      <div style={{ fontWeight: 700 }}>{item.title}</div>
                      <div
                        style={{ color: "#94a3b8", fontSize: 12, marginTop: 4 }}
                      >
                        {item.issueId} · {item.headline}
                      </div>
                    </div>
                    <div>
                      <div
                        style={{
                          color: metricTone(item.decisionScore),
                          fontWeight: 700,
                        }}
                      >
                        {item.decisionScore}/10
                      </div>
                      <div style={{ color: "#94a3b8", fontSize: 12 }}>
                        display {item.qualityScore}/10
                      </div>
                    </div>
                    <div>
                      <span
                        style={{
                          display: "inline-flex",
                          padding: "6px 10px",
                          borderRadius: 999,
                          background: tone.bg,
                          color: tone.fg,
                          fontSize: 12,
                          fontWeight: 700,
                        }}
                      >
                        {statusLabel(item)}
                      </span>
                      <div
                        style={{ color: "#94a3b8", fontSize: 12, marginTop: 6 }}
                      >
                        {item.assignedTo ?? "Unassigned"}
                      </div>
                    </div>
                    <div
                      style={{
                        textAlign: "right",
                        color:
                          item.topRiskLevel === "critical" ||
                          item.topRiskLevel === "high"
                            ? "#fca5a5"
                            : "#94a3b8",
                        fontSize: 12,
                      }}
                    >
                      <div>{item.topRiskLabel ?? "No active risk"}</div>
                      <div style={{ marginTop: 6 }}>
                        {formatDate(item.updatedAt)}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          <div style={panelStyle()}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
                marginBottom: 12,
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: 12,
                    color: "#38bdf8",
                    fontWeight: 700,
                    textTransform: "uppercase",
                  }}
                >
                  Bulk reviewer actions
                </div>
                <h2 style={{ margin: "4px 0 0", fontSize: 22 }}>
                  Ship or return multiple packages at once
                </h2>
              </div>
              <div style={{ color: "#94a3b8", fontSize: 13 }}>
                Uses existing bulk action APIs already registered in the worker
              </div>
            </div>
            <textarea
              value={bulkComment}
              onChange={(event) => setBulkComment(event.target.value)}
              rows={4}
              placeholder="Optional note for bulk approval or required note for bulk revision requests…"
              style={inputStyle()}
            />
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
                marginTop: 12,
              }}
            >
              <button
                disabled={busy || selected.length === 0}
                onClick={() =>
                  runBulkAction(
                    () =>
                      bulkApprove({
                        issue_ids: selected,
                        comment: bulkComment || undefined,
                      }),
                    `Released ${selected.length} review package(s).`,
                  )
                }
                style={buttonStyle("#16a34a", busy || selected.length === 0)}
              >
                Bulk approve & release
              </button>
              <button
                disabled={busy || selected.length === 0 || !bulkComment.trim()}
                onClick={() =>
                  runBulkAction(
                    () =>
                      bulkReject({
                        issue_ids: selected,
                        comment: bulkComment.trim(),
                      }),
                    `Requested revision for ${selected.length} review package(s).`,
                  )
                }
                style={buttonStyle(
                  "#dc2626",
                  busy || selected.length === 0 || !bulkComment.trim(),
                )}
              >
                Bulk request revision
              </button>
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          <div style={panelStyle()}>
            <div
              style={{
                fontSize: 12,
                color: "#38bdf8",
                fontWeight: 700,
                textTransform: "uppercase",
                marginBottom: 10,
              }}
            >
              Agent quality trends
            </div>
            <div style={{ display: "grid", gap: 10 }}>
              {agentTrends.length === 0 ? (
                <div style={{ color: "#94a3b8" }}>
                  No review trend data yet.
                </div>
              ) : (
                agentTrends.slice(0, 6).map((agent) => (
                  <div
                    key={agent.agentId}
                    style={{
                      border: "1px solid #1e293b",
                      borderRadius: 14,
                      padding: 12,
                      background: "#020617",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 12,
                      }}
                    >
                      <strong>{agent.displayName}</strong>
                      <span
                        style={{
                          color: metricTone(agent.avgQualityScore),
                          fontWeight: 700,
                        }}
                      >
                        {agent.avgQualityScore}/10
                      </span>
                    </div>
                    <div
                      style={{ marginTop: 6, color: "#94a3b8", fontSize: 13 }}
                    >
                      {agent.totalReviews} reviews · {agent.approvalRate}%
                      released · {agent.autoRejectRate}% auto-rejected
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div style={panelStyle()}>
            <div
              style={{
                fontSize: 12,
                color: "#38bdf8",
                fontWeight: 700,
                textTransform: "uppercase",
                marginBottom: 10,
              }}
            >
              Reviewer playbook
            </div>
            <ul
              style={{
                margin: 0,
                paddingLeft: 18,
                color: "#cbd5e1",
                lineHeight: 1.7,
              }}
            >
              <li>
                Use decision score for threshold policy and display score for
                operator sentiment.
              </li>
              <li>
                High-risk or secret-bearing submissions should be revised before
                release.
              </li>
              <li>
                Approved + hold is the safest state for deliverables waiting on
                downstream context.
              </li>
              <li>
                Escalate when compliance, legal, privacy, or brand issues exceed
                local reviewer authority.
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

export default QualityGateDashboard;
