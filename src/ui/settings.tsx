import * as React from "react";
import {
  useInstanceConfig,
  usePluginAction,
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

export function QualityGateSettings({
  context,
}: PluginSettingsPageProps) {
  const config = useInstanceConfig<QualityGateSettings>();
  const saveConfig = usePluginAction("plugin_config_update");

  const [minScore, setMinScore] = React.useState(
    config?.minQualityScore ?? 7,
  );
  const [blockThreshold, setBlockThreshold] = React.useState(
    config?.blockThreshold ?? 5,
  );
  const [autoReject, setAutoReject] = React.useState(
    config?.autoRejectBelow ?? 3,
  );
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);

    if (autoReject >= minScore) {
      setError(`autoRejectBelow (${autoReject}) must be less than minQualityScore (${minScore}).`);
      return;
    }
    if (blockThreshold > minScore) {
      setError(`blockThreshold (${blockThreshold}) must be at or below minQualityScore (${minScore}).`);
      return;
    }

    try {
      // @ts-ignore — saveConfig action type
      await saveConfig({
        minQualityScore: minScore,
        blockThreshold,
        autoRejectBelow: autoReject,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div
      style={{
        padding: "24px",
        maxWidth: "600px",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h2
        style={{ margin: "0 0 4px", fontSize: "18px", fontWeight: "bold" }}
      >
        Quality Gate Settings
      </h2>
      <p style={{ margin: "0 0 20px", fontSize: "13px", color: "#6b7280" }}>
        Configure how the quality gate evaluates deliverables. These thresholds
        apply to all issues in this workspace.
      </p>

      <form onSubmit={handleSave}>
        {/* Minimum Quality Score */}
        <SettingRow
          label="Minimum Quality Score"
          description={`Deliverables scoring below this are flagged for human review. Recommended: 7.`}
        >
          <input
            type="number"
            min={0}
            max={10}
            step={0.5}
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value))}
            style={inputStyle}
          />
          <span style={{ fontSize: "13px", color: "#6b7280" }}>/ 10</span>
        </SettingRow>

        {/* Block Threshold */}
        <SettingRow
          label="Block Threshold"
          description={`Scores at or below this with block_approval=true are immediately flagged for review. Recommended: 5.`}
        >
          <input
            type="number"
            min={0}
            max={10}
            step={0.5}
            value={blockThreshold}
            onChange={(e) => setBlockThreshold(Number(e.target.value))}
            style={inputStyle}
          />
          <span style={{ fontSize: "13px", color: "#6b7280" }}>/ 10</span>
        </SettingRow>

        {/* Auto-Reject Below */}
        <SettingRow
          label="Auto-Reject Below"
          description={`Scores strictly below this are automatically rejected without human review. Must be below Minimum. Recommended: 3.`}
        >
          <input
            type="number"
            min={0}
            max={10}
            step={0.5}
            value={autoReject}
            onChange={(e) => setAutoReject(Number(e.target.value))}
            style={inputStyle}
          />
          <span style={{ fontSize: "13px", color: "#6b7280" }}>/ 10</span>
        </SettingRow>

        {/* Validation message */}
        {error && (
          <div
            style={{
              padding: "10px 12px",
              backgroundColor: "#fef2f2",
              border: "1px solid #fca5a5",
              borderRadius: "8px",
              color: "#991b1b",
              fontSize: "13px",
              marginBottom: "16px",
            }}
          >
            {error}
          </div>
        )}

        {/* Saved message */}
        {saved && (
          <div
            style={{
              padding: "10px 12px",
              backgroundColor: "#dcfce7",
              border: "1px solid #86efac",
              borderRadius: "8px",
              color: "#166534",
              fontSize: "13px",
              marginBottom: "16px",
            }}
          >
            ✅ Settings saved successfully.
          </div>
        )}

        <button
          type="submit"
          style={{
            padding: "10px 24px",
            borderRadius: "8px",
            border: "none",
            backgroundColor: "#3b82f6",
            color: "white",
            fontSize: "14px",
            fontWeight: "600",
            cursor: "pointer",
          }}
        >
          Save Settings
        </button>
      </form>

      {/* Info panel */}
      <div
        style={{
          marginTop: "32px",
          padding: "16px",
          backgroundColor: "#f9fafb",
          borderRadius: "8px",
          border: "1px solid #e5e7eb",
        }}
      >
        <h3
          style={{
            margin: "0 0 10px",
            fontSize: "13px",
            fontWeight: "bold",
            color: "#374151",
          }}
        >
          How it works
        </h3>
        <ul
          style={{
            margin: 0,
            paddingLeft: "20px",
            fontSize: "13px",
            color: "#6b7280",
            lineHeight: "1.8",
          }}
        >
          <li>
            Agents call the <code style={codeStyle}>quality_gate_review</code>{" "}
            tool after completing a deliverable.
          </li>
          <li>
            Quality is evaluated across five categories: completeness,
            correctness, clarity, test coverage, documentation.
          </li>
          <li>
            Scores below <strong>Auto-Reject Below</strong> are automatically
            rejected — the issue returns to <em>in_progress</em>.
          </li>
          <li>
            Scores below <strong>Minimum</strong> or with{" "}
            <code style={codeStyle}>block_approval=true</code> require human
            review via the Quality Gate tab.
          </li>
          <li>
            Approval marks the issue as <strong>done</strong>; rejection returns
            it to <em>in_progress</em> for the agent to address.
          </li>
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: "24px",
        marginBottom: "20px",
      }}
    >
      <div style={{ flex: 1 }}>
        <div
          style={{ fontSize: "13px", fontWeight: "600", color: "#374151" }}
        >
          {label}
        </div>
        <div
          style={{ fontSize: "12px", color: "#6b7280", marginTop: "2px" }}
        >
          {description}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        {children}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "72px",
  padding: "6px 10px",
  borderRadius: "6px",
  border: "1px solid #d1d5db",
  fontSize: "14px",
  textAlign: "center",
};

const codeStyle: React.CSSProperties = {
  backgroundColor: "#f3f4f6",
  padding: "1px 5px",
  borderRadius: "4px",
  fontSize: "12px",
  fontFamily: "monospace",
};
