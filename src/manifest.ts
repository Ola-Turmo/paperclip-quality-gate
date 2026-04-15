import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import type { QualityGateSettings } from "./types.js";

export const PLUGIN_ID = "uos-quality-gate";
export const PLUGIN_VERSION = "1.0.0";

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
    "Universal quality gate for the UOS ecosystem. " +
    "Evaluates agent deliverables against configurable thresholds and " +
    "enforces human approval before work can be marked done. " +
    "Protocol: quality_gate.submit | quality_gate.approve | quality_gate.reject. " +
    "Streams: quality_gate.review_created | quality_gate.review_updated | " +
    "quality_gate.review_approved | quality_gate.review_rejected | " +
    "quality_gate.threshold_breached.",
  author: "turmo.dev",
  categories: ["automation"],
  capabilities: [
    // Events
    "events.subscribe",
    // State
    "plugin.state.read",
    "plugin.state.write",
    // Issues
    "issues.read",
    "issues.update",
    "issue.comments.read",
    "issue.comments.create",
    // Activity & observability
    "activity.log.write",
    "metrics.write",
    "telemetry.track",
    // Agent tools (our own registered tools)
    "agent.tools.register",
    // UI
    "ui.detailTab.register",
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
          "Score below this (and no blockers) → passes auto-gate for human review. " +
          "Scores below autoRejectBelow are auto-rejected without human review.",
      },
      blockThreshold: {
        type: "number",
        minimum: 0,
        maximum: 10,
        default: DEFAULT_CONFIG.blockThreshold,
        title: "Block Threshold",
        description:
          "Scores at or below this with block_approval=true force immediate human review. " +
          "Also applies when block_approval flag is set regardless of score.",
      },
      autoRejectBelow: {
        type: "number",
        minimum: 0,
        maximum: 10,
        default: DEFAULT_CONFIG.autoRejectBelow,
        title: "Auto-Reject Below",
        description:
          "Scores strictly below this value are automatically rejected " +
          "without human review. Agent should fix and resubmit.",
      },
      customChecks: {
        type: "array",
        default: [],
        title: "Custom Quality Checks",
        description:
          "Structured rules evaluated at every review. " +
          "Types: label_required (value=labelName), label_missing (value=labelName), " +
          "title_contains (value=comma,kewords), has_assignee. " +
          "Each check contributes scoreBonus points when passed.",
        items: {
          type: "object",
          required: ["id", "name", "type"],
          properties: {
            id: {
              type: "string",
              title: "Check ID",
              description: "Unique identifier for this check (used as prefix in results)",
            },
            name: {
              type: "string",
              title: "Display Name",
              description: "Human-readable name shown in the review checks list",
            },
            type: {
              type: "string",
              enum: ["label_required", "label_missing", "title_contains", "has_assignee"],
              title: "Check Type",
            },
            value: {
              type: "string",
              title: "Value",
              description:
                "Type-specific value: label name for label_* types, " +
                "comma-separated keywords for title_contains, unused for has_assignee",
            },
            scoreBonus: {
              type: "number",
              minimum: 0,
              maximum: 10,
              default: 0,
              title: "Score Bonus",
              description: "Points added to quality score when this check passes (0–10)",
            },
          },
        },
      },
    },
  },
  tools: [
    {
      name: "quality_gate_review",
      displayName: "Quality Gate — Check Review Status",
      description:
        "Check the quality gate review status for a Paperclip issue. " +
        "Returns the current review state, quality score, check breakdown, " +
        "and audit history. Does not modify any state.",
      parametersSchema: {
        type: "object",
        properties: {
          issue_id: {
            type: "string",
            description: "The Paperclip issue ID to check the review status for.",
          },
          include_checks: {
            type: "boolean",
            description:
              "If true, includes the full per-check quality breakdown. " +
              "Default: false (returns summary only).",
            default: false,
          },
        },
        required: ["issue_id"],
      },
    },
    {
      name: "submit_for_review",
      displayName: "Quality Gate — Submit for Review",
      description:
        "Submit a completed deliverable for quality gate review. " +
        "Runs the quality evaluation, creates or updates the review record, " +
        "and posts a comment on the issue. " +
        "Agents should call this when they believe work is complete.",
      parametersSchema: {
        type: "object",
        properties: {
          issue_id: {
            type: "string",
            description: "The Paperclip issue ID to submit for review.",
          },
          summary: {
            type: "string",
            description:
              "Brief summary of what was delivered. " +
              "Included in the review record and issue comment.",
          },
          quality_score: {
            type: "number",
            description:
              "Self-assessed quality score from 0–10. " +
              "Used as the primary input to the quality gate evaluation. " +
              "If omitted, evaluation runs with no score and deliverable " +
              "is flagged for human review.",
          },
          block_approval: {
            type: "boolean",
            description:
              "If true, forces human review regardless of quality score. " +
              "Use when the deliverable involves subjective criteria " +
              "or elevated risk.",
            default: false,
          },
          comment: {
            type: "string",
            description:
              "Optional comment to attach to the review submission. " +
              "Shown in the issue comment and review history.",
          },
        },
        required: ["issue_id"],
      },
    },
  ],
  ui: {
    slots: [
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
