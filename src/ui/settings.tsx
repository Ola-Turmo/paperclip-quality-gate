import * as React from "react";
import {
  usePluginData,
  type PluginSettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";

// =============================================================================
// Types
// =============================================================================

interface QualityGateSettings {
  minQualityScore?: number;
  blockThreshold?: number;
  autoRejectBelow?: number;
}

// =============================================================================
// Settings Page Component
// =============================================================================

/**
 * Quality Gate plugin settings.
 *
 * Configuration is set by the operator via the host settings UI (the form
 * rendered from `instanceConfigSchema` in manifest.ts). This page is
 * read-only — it displays the current resolved config.
 */
export function QualityGateSettings({
  context,
}: PluginSettingsPageProps) {
  const { data: config, loading } = usePluginData<QualityGateSettings>(
    "plugin_config_get",
    {}
  );

  const minScore = config?.minQualityScore ?? 7;
  const blockThreshold = config?.blockThreshold ?? 5;
  const autoReject = config?.autoRejectBelow ?? 3;

  return (
    <div style={{ padding: "24px", maxWidth: "560px", fontFamily: "system-ui, sans-serif" }}>
      <h2 style={{ margin: "0 0 6px", fontSize: "18px", fontWeight: 600 }}>
        Quality Gate Settings
      </h2>
      <p style={{ margin: "0 0 20px", fontSize: "13px", color: "#666" }}>
        Configure thresholds for the UOS quality gate. These values are set by
        the operator via the host settings panel.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <SettingRow
          label="Minimum Quality Score"
          value={String(minScore)}
          description="Score below this (and no blockers) is needed to pass the gate."
        />
        <SettingRow
          label="Block Threshold"
          value={String(blockThreshold)}
          description="Scores at or below this with block_approval=true flag for human review."
        />
        <SettingRow
          label="Auto-Reject Below"
          value={String(autoReject)}
          description="Scores strictly below this are automatically rejected without human review."
        />
      </div>

      {loading && (
        <p style={{ marginTop: "16px", fontSize: "13px", color: "#888" }}>
          Loading configuration…
        </p>
      )}
    </div>
  );
}

function SettingRow({
  label,
  value,
  description,
}: {
  label: string;
  value: string;
  description: string;
}) {
  return (
    <div
      style={{
        padding: "12px 14px",
        background: "#f5f5f5",
        borderRadius: "8px",
        border: "1px solid #e0e0e0",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 500, fontSize: "14px" }}>{label}</span>
        <span
          style={{
            fontFamily: "monospace",
            fontSize: "14px",
            background: "#fff",
            padding: "2px 8px",
            borderRadius: "4px",
            border: "1px solid #ddd",
          }}
        >
          {value}
        </span>
      </div>
      <p style={{ margin: "4px 0 0", fontSize: "12px", color: "#777" }}>{description}</p>
    </div>
  );
}
