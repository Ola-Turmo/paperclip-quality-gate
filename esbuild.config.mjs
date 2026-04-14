import * as esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk";

const presets = createPluginBundlerPresets({
  manifest: "src/manifest.ts",
  workerEntry: "src/worker.ts",
  uiEntry: "src/ui/index.tsx",
});

const watch = process.argv.includes("--watch");

async function buildAll() {
  const results = await Promise.all([
    esbuild.build(presets.manifest),
    esbuild.build(presets.worker),
    esbuild.build(presets.ui),
  ]);

  const [manifestResult, workerResult, uiResult] = results;

  console.log(
    "Manifest:",
    manifestResult.errors.length ? `FAILED (${manifestResult.errors.length})` : "OK",
  );
  console.log(
    "Worker: ",
    workerResult.errors.length ? `FAILED (${workerResult.errors.length})` : "OK",
  );
  console.log(
    "UI:     ",
    uiResult.errors.length ? `FAILED (${uiResult.errors.length})` : "OK",
  );

  if (manifestResult.errors.length || workerResult.errors.length || uiResult.errors.length) {
    process.exit(1);
  }
}

if (watch) {
  // Watch mode — rebuild on change
  const ctx1 = await esbuild.context(presets.manifest);
  const ctx2 = await esbuild.context(presets.worker);
  const ctx3 = await esbuild.context(presets.ui);

  await Promise.all([ctx1.watch(), ctx2.watch(), ctx3.watch()]);
  console.log("esbuild watch mode enabled for manifest, worker, and ui");
} else {
  await buildAll();
}
