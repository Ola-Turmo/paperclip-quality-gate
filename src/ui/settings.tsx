import React from "react";
import { usePluginData, type PluginSettingsPageProps } from "@paperclipai/plugin-sdk/ui";
import type { QualityGateSettings } from "../types.js";
import { DEFAULT_CONFIG } from "../manifest.js";

export function QualityGateSettings(_props: PluginSettingsPageProps) {
  const { data, loading, error } = usePluginData<Partial<QualityGateSettings>>("quality_gate.config", {});
  const config = { ...DEFAULT_CONFIG, ...data };

  return (
    <div style={{ padding: 24, maxWidth: 880, fontFamily: "Inter, sans-serif", color: "#0f172a" }}>
      <h2 style={{ margin: 0, fontSize: 24 }}>Quality Gate settings</h2>
      <p style={{ margin: "10px 0 18px", color: "#475569", lineHeight: 1.6 }}>
        The current release policy is driven by threshold scoring plus optional structured checks. The custom settings page is intentionally read-only today because the installed Paperclip bridge exposes resolved config but not config writes yet.
      </p>

      {error ? <p style={{ color: "#dc2626" }}>{error.message}</p> : null}

      <div style={{ display: "grid", gap: 14 }}>
        <SettingRow label="Minimum quality score" value={String(config.minQualityScore)} description="Decision scores at or above this can move into the reviewer approval lane." />
        <SettingRow label="Block threshold" value={String(config.blockThreshold)} description="Decision scores at or below this stay in human review until a reviewer chooses the next step." />
        <SettingRow label="Auto-reject below" value={String(config.autoRejectBelow)} description="Decision scores below this are immediately returned for revision." />
        <SettingRow label="Structured checks" value={String(config.customChecks?.length ?? 0)} description="Declarative metadata checks that add bonus points and surface richer reviewer context." />
      </div>

      <div style={{ marginTop: 22, padding: 16, borderRadius: 14, background: "#eff6ff", border: "1px solid #bfdbfe" }}>
        <strong style={{ display: "block", marginBottom: 8 }}>Security and evidence handling</strong>
        <ul style={{ margin: 0, paddingLeft: 18, color: "#334155", lineHeight: 1.6 }}>
          <li>Evidence packages redact common secret patterns before storing markdown artifacts.</li>
          <li>Review history, evidence hashes, and next-step templates are written back to issue documents for auditability.</li>
          <li>Dashboard, queue, and issue-detail UI all read from the same company-scoped review state.</li>
        </ul>
      </div>

      {loading ? <p style={{ marginTop: 16, color: "#64748b" }}>Loading configuration…</p> : null}
    </div>
  );
}

function SettingRow({ label, value, description }: { label: string; value: string; description: string }) {
  return (
    <div style={{ padding: 14, borderRadius: 14, background: "#f8fafc", border: "1px solid #e2e8f0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <strong>{label}</strong>
        <span style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", background: "white", border: "1px solid #cbd5e1", borderRadius: 999, padding: "4px 10px" }}>{value}</span>
      </div>
      <p style={{ margin: "8px 0 0", color: "#64748b", fontSize: 13 }}>{description}</p>
    </div>
  );
}

export default QualityGateSettings;
