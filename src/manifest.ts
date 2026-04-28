import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import type { QualityGateSettings } from "./types.js";

export const PLUGIN_ID = "uos-quality-gate";
export const PLUGIN_VERSION = "2.1.0";

export const DEFAULT_CONFIG: QualityGateSettings = {
  minQualityScore: 7,
  blockThreshold: 5,
  autoRejectBelow: 3,
  customChecks: [],
};

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "UOS Quality Gate",
  description:
    "Evidence-centric quality gate workbench for Paperclip. Packages every deliverable into an auditable review queue with draft output, risk cards, next-step routing, and human-in-the-loop release controls.",
  author: "turmo.dev",
  categories: ["automation", "ui"],
  capabilities: [
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "issues.read",
    "issues.update",
    "issue.comments.read",
    "issue.comments.create",
    "issue.documents.read",
    "issue.documents.write",
    "activity.log.write",
    "metrics.write",
    "telemetry.track",
    "agent.tools.register",
    "ui.detailTab.register",
    "ui.page.register",
    "ui.dashboardWidget.register",
    "instance.settings.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    required: [],
    properties: {
      minQualityScore: {
        type: "number",
        minimum: 0,
        maximum: 10,
        default: DEFAULT_CONFIG.minQualityScore,
        title: "Minimum Quality Score",
        description:
          "Decision scores at or above this value are ready for reviewer approval.",
      },
      blockThreshold: {
        type: "number",
        minimum: 0,
        maximum: 10,
        default: DEFAULT_CONFIG.blockThreshold,
        title: "Human Review Threshold",
        description:
          "Decision scores at or below this threshold stay in the human-review lane.",
      },
      autoRejectBelow: {
        type: "number",
        minimum: 0,
        maximum: 10,
        default: DEFAULT_CONFIG.autoRejectBelow,
        title: "Auto-Reject Below",
        description:
          "Decision scores below this threshold are returned for revision automatically.",
      },
      customChecks: {
        type: "array",
        default: [],
        title: "Structured Quality Checks",
        description:
          "Safe, declarative rules evaluated against issue metadata. Passed checks can contribute bonus points to the decision score.",
        items: {
          type: "object",
          required: ["id", "name", "type"],
          properties: {
            id: { type: "string", title: "Check ID" },
            name: { type: "string", title: "Display Name" },
            type: {
              type: "string",
              enum: [
                "label_required",
                "label_missing",
                "title_contains",
                "has_assignee",
              ],
              title: "Check Type",
            },
            value: {
              type: "string",
              title: "Value",
              description:
                "Label name or comma-separated keywords depending on check type.",
            },
            scoreBonus: {
              type: "number",
              minimum: 0,
              maximum: 10,
              default: 0,
              title: "Score Bonus",
            },
          },
        },
      },
    },
  },
  tools: [
    {
      name: "quality_gate_review",
      displayName: "Quality Gate — Review Package",
      description:
        "Inspect the current review package for an issue, including release state, evidence hash, risks, and optional detailed checks/trace.",
      parametersSchema: {
        type: "object",
        properties: {
          issue_id: { type: "string", description: "Paperclip issue ID." },
          include_checks: {
            type: "boolean",
            description:
              "Include detailed checks, trace, and next-step output.",
            default: false,
          },
        },
        required: ["issue_id"],
      },
    },
    {
      name: "submit_for_review",
      displayName: "Quality Gate — Submit Evidence Package",
      description:
        "Create or refresh a deliverable review package and persist the evidence/next-step documents on the issue.",
      parametersSchema: {
        type: "object",
        properties: {
          issue_id: { type: "string", description: "Paperclip issue ID." },
          summary: {
            type: "string",
            description: "Summary of the completed work.",
          },
          quality_score: {
            type: "number",
            description: "Self-assessed quality score from 0–10.",
          },
          block_approval: {
            type: "boolean",
            description: "Force manual review regardless of score.",
            default: false,
          },
          comment: {
            type: "string",
            description: "Optional note for reviewers.",
          },
        },
        required: ["issue_id"],
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "quality-gate-widget",
        displayName: "Quality Gate",
        exportName: "QualityGateDashboardWidget",
      },
      {
        type: "page",
        id: "quality-gate-dashboard",
        displayName: "Quality Gate",
        exportName: "QualityGateDashboard",
        routePath: "quality-gate",
      },
      {
        type: "detailTab",
        id: "quality-gate-tab",
        displayName: "Quality Gate",
        exportName: "QualityGateTab",
        entityTypes: ["issue"],
      },
      {
        type: "settingsPage",
        id: "quality-gate-settings",
        displayName: "Quality Gate",
        exportName: "QualityGateSettings",
      },
    ],
  },
};

export default manifest;
