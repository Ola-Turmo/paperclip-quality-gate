import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "uos-quality-gate",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "UOS Quality Gate",
  description:
    "Quality gate for Paperclip UOS — review deliverables before approval. Blocks agents from marking work done until a human or automated reviewer approves it.",
  categories: ["automation", "ui"],
  capabilities: [
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "ui.detailTab.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
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
