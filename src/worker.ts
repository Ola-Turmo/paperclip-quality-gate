import type { PluginWorkerRegistrar } from "@paperclipai/plugin-sdk";

export default function registerHandlers(_ctx: Parameters<PluginWorkerRegistrar>[0]) {
  // Register data handlers
  // _ctx.data.register(..., async (query) => { ... });

  // Register action handlers
  // _ctx.actions.register(..., async (params) => { ... });

  // Register tool handlers
  // _ctx.tools.register("myTool", { ... }, async (params, _runCtx) => { ... });

  // Register job handlers
  // _ctx.jobs.register(..., async (jobCtx) => { ... });
}
