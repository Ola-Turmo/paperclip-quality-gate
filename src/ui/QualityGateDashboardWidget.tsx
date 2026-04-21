import React from "react";
import { usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import type { ReviewQueueData } from "../types.js";

function widgetShell(): React.CSSProperties {
  return {
    padding: 16,
    borderRadius: 16,
    background: "linear-gradient(180deg, #0f172a 0%, #111827 100%)",
    color: "#e2e8f0",
    border: "1px solid #1f2937",
    fontFamily: "Inter, system-ui, sans-serif",
  };
}

function metricColor(score: number): string {
  if (score >= 7) return "#22c55e";
  if (score >= 5) return "#f59e0b";
  return "#ef4444";
}

export function QualityGateDashboardWidget({ context }: PluginWidgetProps) {
  const companyId = context.companyId ?? "";
  const queueQuery = usePluginData<ReviewQueueData>("quality_gate.queue", { companyId });
  const summary = queueQuery.data?.summary;
  const topItem = queueQuery.data?.items[0];

  if (!companyId) {
    return <div style={widgetShell()}>Open within a company to see Quality Gate metrics.</div>;
  }

  return (
    <div style={widgetShell()}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 12, color: "#38bdf8", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.1 }}>Quality Gate</div>
          <h3 style={{ margin: "6px 0 0", fontSize: 22 }}>Release queue snapshot</h3>
        </div>
        <div style={{ fontSize: 13, color: "#94a3b8" }}>{queueQuery.loading && !queueQuery.data ? "Loading..." : `${summary?.totalReviews ?? 0} total`}</div>
      </div>

      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(3, minmax(0, 1fr))", marginBottom: 14 }}>
        <Metric label="Needs review" value={String(summary?.pendingReviews ?? 0)} tone="#facc15" />
        <Metric label="Approved + hold" value={String(summary?.approvedHoldReviews ?? 0)} tone="#93c5fd" />
        <Metric label="Released" value={String(summary?.releasedReviews ?? 0)} tone="#34d399" />
      </div>

      <div style={{ padding: 12, borderRadius: 14, background: "rgba(2,6,23,0.8)", border: "1px solid #1e293b" }}>
        <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>Average decision score</div>
        <div style={{ fontSize: 24, fontWeight: 800, color: metricColor(summary?.averageDecisionScore ?? 0) }}>{summary?.averageDecisionScore ?? 0}/10</div>
        <div style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>{summary?.highRiskReviews ?? 0} high-risk packages | {summary?.unassignedPendingReviews ?? 0} unassigned pending</div>
      </div>

      {topItem ? (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #1f2937" }}>
          <div style={{ fontSize: 12, color: "#38bdf8", fontWeight: 700, textTransform: "uppercase", marginBottom: 6 }}>Most recent package</div>
          <div style={{ fontWeight: 700 }}>{topItem.title}</div>
          <div style={{ color: "#94a3b8", fontSize: 13, marginTop: 4 }}>{topItem.issueId} | {topItem.headline}</div>
          <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 8 }}>Risk: {topItem.topRiskLabel ?? "No active risk"}</div>
        </div>
      ) : null}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div style={{ padding: 10, borderRadius: 12, background: "rgba(2,6,23,0.8)", border: "1px solid #1e293b" }}>
      <div style={{ fontSize: 11, color: "#94a3b8", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: tone, marginTop: 4 }}>{value}</div>
    </div>
  );
}

export default QualityGateDashboardWidget;
