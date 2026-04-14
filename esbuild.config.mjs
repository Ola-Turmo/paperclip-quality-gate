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
  console.log("Watch mode not yet implemented — run without --watch");
  process.exit(1);
} else {
  buildAll().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
