import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import type { QualityGateConfig } from "./types.js";

export const DEFAULT_CONFIG: QualityGateConfig = {
  minQualityScore: 7,
  blockThreshold: 5,
  autoRejectBelow: 3,
};

const manifest: PaperclipPluginManifestV1 = {
  id: "uos-quality-gate",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "UOS Quality Gate",
  description:
    "Quality gate for Paperclip UOS — review deliverables before approval. " +
    "Blocks agents from marking work done until a reviewer approves it. " +
    "Supports configurable quality thresholds, auto-rejection, and full audit trail.",
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
        default: 7,
        title: "Minimum Quality Score",
        description:
          "Score below this (and no blockers) is needed to pass the gate. " +
          "Deliverables below autoRejectBelow are auto-rejected.",
      },
      blockThreshold: {
        type: "number",
        minimum: 0,
        maximum: 10,
        default: 5,
        title: "Block Threshold",
        description:
          "Scores at or below this with block_approval=true will flag " +
          "the deliverable immediately for human review.",
      },
      autoRejectBelow: {
        type: "number",
        minimum: 0,
        maximum: 10,
        default: 3,
        title: "Auto-Reject Below",
        description:
          "Scores strictly below this value are automatically rejected " +
          "without human review.",
      },
    },
  },
  ui: {
    slots: [
      {
        type: "detailTab",
        id: "quality-gate-tab",
        displayName: "Quality Gate",
        exportName: "QualityGateTab",
        entityTypes: ["issue"],
      },
    ],
  },
};

export default manifest;
