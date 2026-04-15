import * as esbuild from "esbuild";

async function buildAll() {
  // --- manifest ---
  await esbuild.build({
    entryPoints: ["src/manifest.ts"],
    bundle: false,
    outfile: "dist/manifest.js",
    format: "esm",
    platform: "node",
    target: "node18",
  });

  // --- worker ---
  await esbuild.build({
    entryPoints: ["src/worker.ts"],
    bundle: true,
    outfile: "dist/worker.js",
    format: "esm",
    platform: "node",
    target: "node18",
    external: ["react", "react-dom"],
    logLevel: "info",
  });

  // --- ui ---
  await esbuild.build({
    entryPoints: ["src/ui/index.tsx"],
    bundle: true,
    outdir: "dist/ui",
    format: "esm",
    platform: "browser",
    target: "chrome120",
    jsx: "automatic",
    external: ["react", "react-dom"],
    loader: { ".tsx": "tsx", ".ts": "ts", ".js": "js" },
    logLevel: "info",
  });

  console.log("✅ Build complete");
}

const watch = process.argv.includes("--watch");
if (watch) {
  // Build once then watch all targets
  await buildAll();
  console.log("👀 Watch mode active — press Ctrl+C to stop");

  const ctxManifest = await esbuild.context({
    entryPoints: ["src/manifest.ts"],
    bundle: false,
    outfile: "dist/manifest.js",
    format: "esm",
    platform: "node",
    target: "node18",
    logLevel: "info",
  });

  const ctxWorker = await esbuild.context({
    entryPoints: ["src/worker.ts"],
    bundle: true,
    outfile: "dist/worker.js",
    format: "esm",
    platform: "node",
    target: "node18",
    external: ["react", "react-dom"],
    logLevel: "info",
  });

  const ctxUi = await esbuild.context({
    entryPoints: ["src/ui/index.tsx"],
    bundle: true,
    outdir: "dist/ui",
    format: "esm",
    platform: "browser",
    target: "chrome120",
    jsx: "automatic",
    external: ["react", "react-dom"],
    loader: { ".tsx": "tsx", ".ts": "ts", ".js": "js" },
    logLevel: "info",
  });

  await Promise.all([ctxManifest.watch(), ctxWorker.watch(), ctxUi.watch()]);

  // Keep process alive
  await new Promise(() => {});
} else {
  buildAll().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
