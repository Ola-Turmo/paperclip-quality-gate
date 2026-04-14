import * as esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk";

const presets = createPluginBundlerPresets({
  manifest: "src/manifest.ts",
  workerEntry: "src/worker.ts",
  uiEntry: "src/ui/index.tsx",
});

const config = {
  manifest: {
    bundle: true,
    external: ["@paperclipai/plugin-sdk"],
    alias: {
      "@paperclipai/plugin-sdk": "/root/work/paperclip/packages/plugins/sdk/src",
    },
  },
  worker: {
    bundle: true,
    external: ["@paperclipai/plugin-sdk"],
    alias: {
      "@paperclipai/plugin-sdk": "/root/work/paperclip/packages/plugins/sdk/src",
    },
  },
  ui: {
    bundle: true,
    external: ["@paperclipai/plugin-sdk"],
    alias: {
      "@paperclipai/plugin-sdk": "/root/work/paperclip/packages/plugins/sdk/src",
    },
  },
};

const result = await esbuild.build(presets.manifest(config.manifest));
console.log("Manifest build:", result.errors.length ? "FAILED" : "OK");
