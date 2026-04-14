# Paperclip Quality-Gate Plugin Architecture

We recommend implementing the deliverable quality-and-review **gate as a Paperclip plugin**. The plugin runtime provides event hooks, persistent state, and UI extension points needed for this flow, without altering core task or approval logic【13†L609-L618】【32†L1039-L1043】. A plugin can subscribe to agent and issue events, update task status, and maintain its own review records. In contrast, an *adapter* is for new agent types (not relevant here) and a simple *agent tool* would not span tasks or UI; a plugin is the proper cross-cutting mechanism.

The plugin’s manifest (in `dist/manifest.js`) should declare an `id`, `version`, `displayName`, `description`, `categories`, `capabilities`, `entrypoints`, and (if needed) `instanceConfigSchema` and UI `slots`【13†L609-L618】【13†L631-L642】. For example, categories might be `["automation","ui"]`. Capabilities must include **`events.subscribe`** (to listen for task/deliverable events), **`issues.read`/`issues.update`** (to inspect and change task status), **`issue.comments.read/create`** (to log comments about quality), **`plugin.state.read`/`plugin.state.write`** (for persistent review data), and UI permissions (e.g. `ui.detailTab.register` if adding an issue-tab)【13†L609-L618】【32†L1039-L1043】. The plugin worker (in TypeScript) uses `definePlugin({ ... })` from `@paperclipai/plugin-sdk` (as shown in examples【21†L1023-L1030】). Its `register(ctx)` callback will hook into events, register any scheduled jobs or agent tools, and set up `ctx.data`/`ctx.actions` handlers for the UI【21†L1048-L1052】【21†L1079-L1083】.

**Minimum Capability Set:** As an example, the manifest’s `capabilities` array might include:
- `events.subscribe` (to get Paperclip domain events)【18†L1102-L1105】.  
- `issues.read`, `issues.update` (to examine and move tasks)【32†L1029-L1036】.  
- `issue.comments.read`, `issue.comments.create` (to annotate tasks)【32†L1029-L1036】.  
- `plugin.state.read`, `plugin.state.write` (to store review status per deliverable)【32†L1040-L1043】.  
- UI registration caps (e.g. `ui.detailTab.register`, `ui.page.register`) if adding UI components【13†L631-L642】【32†L1058-L1064】.  
- Optionally `jobs.schedule` if periodic scanning is needed, and `agent.tools.register` if we offer an agent-callable tool.  

Each capability gate is enforced by Paperclip’s SDK (for example, declaring `issues.update` is required before calling `ctx.issues.update(...)`)【13†L609-L618】【32†L1045-L1053】. The forbidden capabilities (e.g. `approval.decide`) are not needed here, since we do not override core approvals【32†L1067-L1075】.

## MVP Scope

An MVP plugin can focus on the core flow: **detect – evaluate – block – notify – human review – finalize**. Specifically:
- **Detect deliverable:** Subscribe to events indicating a deliverable is ready. For example, the plugin can listen to `agent.run.finished` (or `agent.run.completed`) events【18†L1102-L1105】 and check if the run produced an external artifact (e.g. a document or email). Alternatively, hook `issue.comment.created` if agents post deliverables as issue comments.  
- **Evaluate quality:** In the event handler, apply basic quality checks (e.g. grammar, style, required sections). Even a simple placeholder check or call to an LLM could work. Compute a “score” or pass/fail judgment.  
- **Mark blocked/pending-review:** If quality fails, update the corresponding task (issue) status to something like *“Blocked”* or *“In Review”*【41†L204-L212】. Use `ctx.issues.update({issueId, updates: { status: "blocked" }})`【32†L1029-L1036】. Save the quality score and metadata in plugin state (`ctx.state`) keyed by the issue ID. Optionally post a comment to the issue via `ctx.issues.comment.create` noting that review is pending.  
- **Hand off to human:** In the UI, show the deliverable as pending review. The human operator (board) then reviews it. The plugin can support two actions: *Approve* or *Reject*.  
  - On **Approve**, the plugin sets status to “Done” (or clears the block) and records the approval in state/audit log.  
  - On **Reject** (or *Request Revision*), the plugin lets the human enter rejection reasons and required edits. It then updates the state (and possibly comments on the issue) so the agent can revise the deliverable. The task might return to “In Progress” or “Blocked” again until fixed.  
- **Audit trail:** Each approve/reject should be logged. The plugin can write to the activity log (`ctx.activity.log.write`) or just store history entries in `ctx.state`.  

This covers the user story with minimal plumbing. We will flesh out these steps in code (see pseudocode below).  

## Plugin Manifest (Example)

```ts
// dist/manifest.js (PaperclipPluginManifestV1)
export default {
  id: "@example/paperclip-plugin-quality-gate",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Quality Gate",
  description: "Blocks deliverables until a human approves them against quality rules.",
  categories: ["automation","ui"],
  minimumPaperclipVersion: "2026.1.0",
  capabilities: [
    "events.subscribe",
    "issues.read",
    "issues.update",
    "issue.comments.read",
    "issue.comments.create",
    "plugin.state.read",
    "plugin.state.write",
    "ui.detailTab.register"
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui/"
  },
  ui: {
    slots: [
      {
        type: "detailTab",
        id: "deliverable-review-tab",
        displayName: "Deliverable Review",
        entityTypes: ["issue"],
        exportName: "DeliverableReviewTab"
      }
    ]
  }
};
```

This manifest (modeled on the spec) declares one UI detail-tab slot on issues【13†L631-L642】. We request permissions for events and issue updates as needed【32†L1029-L1036】. In TypeScript, the plugin would be defined with `definePlugin({...})` in `worker.ts`, using this manifest.

## Event Flow & Lifecycle

1. **Deliverable Ready:** An agent finishes generating an external artifact. Paperclip emits an `agent.run.finished` event【18†L1102-L1105】. The plugin’s worker has subscribed to this event via `ctx.events.on("agent.run.finished", handler)`. (We can filter by company or project if desired.)【21†L1048-L1052】  
2. **Evaluate Quality:** In the event handler, fetch the run details or output (if accessible). Compute quality: e.g. run a checklist or external QA tool.  
3. **Mark Blocked:** If quality is insufficient, call `ctx.issues.update({issueId, updates: { status: "blocked" }})`【32†L1029-L1036】. Then save state, e.g. `ctx.state.set({pluginId, scopeKind:"issue", scopeId: issueId, namespace:"deliverable", stateKey:"review"}, { status: "pending", score: 65, issues: [ ... ] })`. Optionally add an issue comment (via `ctx.issues.comment.create`) noting “Quality gate: pending board review”  
4. **Human Review UI:** The plugin UI (e.g. a detail-tab on the issue) queries `ctx.state.get({ ... })` via `usePluginData("deliverableStatus")`【21†L1079-L1083】. It shows the score/checklist, and offers **Approve** or **Reject** buttons (bound to plugin actions).  
5. **Approve:** When the user clicks Approve, the plugin’s `ctx.actions.register("approveDeliverable", handler)` runs. The handler sets state `status="approved"`, logs the decision, and updates the issue to Done (or simply unblocks it).  
6. **Reject/Revise:** If user rejects or requests changes, `ctx.actions.register("rejectDeliverable", handler)` runs. It records the rejection note in state, and resets the issue status to e.g. “todo” so agents can retry. The state now includes `status="needs_revision"` and a list of comments.  
7. **Audit Trail:** Each action (approve/reject) writes to `ctx.activity.log.write` or appends to `ctx.state` history. This provides an immutable log of who did what and why.  

   <!-- Sequence: RunFinished event → evaluate → (if fail) update issue.status, create state record → UI shows record → user clicks approve/reject → action updates state & issue status. -->

By following this lifecycle, every external artifact is automatically checked and held for board oversight. The use of core task states (“Blocked” or “In Review”) aligns with Paperclip’s workflow【41†L204-L212】, and our plugin does *not* bypass core governance – it simply uses events and issue updates to enforce the gate.

## UI Entry Points

For minimal UI, the plugin can add a **detail tab on each task (issue)** that contains a deliverable awaiting review. In `manifest.ui.slots` we registered a slot of type `"detailTab"` for `entityTypes: ["issue"]`【13†L631-L642】. In the tab’s React component (exported as `DeliverableReviewTab`), we use the SDK’s bridge hooks: 

```jsx
// Example plugin UI component
import { usePluginData, usePluginAction } from "@paperclipai/plugin-sdk/ui";
export function DeliverableReviewTab({ context }) {
  const { data, loading } = usePluginData("deliverableStatus", { issueId: context.issueId });
  const approve = usePluginAction("approveDeliverable");
  const reject = usePluginAction("rejectDeliverable");
  if (loading) return <div>Loading...</div>;
  return (
    <div>
      <h3>Quality Review</h3>
      <p>Status: {data.status}</p>
      <p>Score: {data.score}</p>
      {/* Display checklist/results */}
      <button onClick={() => approve({issueId: context.issueId})}>Approve</button>
      <button onClick={() => {
          const reason = prompt("Rejection note:");
          reject({issueId: context.issueId, reason});
        }}>Request Changes</button>
    </div>
  );
}
```

This component (similar to examples【18†L1218-L1226】【21†L1079-L1083】) asks the worker for `deliverableStatus` data and calls actions. The host mounts it in the issue view. Optionally, one could add a **top-level plugin page** listing all pending reviews (using a `ui.page` slot) or a **dashboard widget** summarizing quality metrics. But for MVP, the issue detail tab is sufficient to gate each deliverable.

## Worker Pseudocode (TypeScript)

```ts
import { definePlugin, z } from "@paperclipai/plugin-sdk";

export default definePlugin({
  id: "quality-gate",
  version: "0.1.0",
  categories: ["automation","ui"],
  capabilities: [
    "events.subscribe",
    "issues.read","issues.update","issue.comments.create",
    "plugin.state.read","plugin.state.write",
    "ui.detailTab.register"
  ],
  instanceConfigSchema: z.object({
    // e.g. quality thresholds or rules
    minScore: z.number().default(80)
  }),
  async register(ctx) {
    // 1. Subscribe to agent runs
    ctx.events.on("agent.run.finished", async (event) => {
      const { runId, agentId, projectId, companyId } = event.payload;
      // Fetch run details or output if needed (not shown)
      // Determine associated issue/task:
      const issueId = event.payload.issueId; // assume event carries this
      if (!issueId) return;
      // Evaluate deliverable (placeholder logic)
      const score = await evaluateDeliverable(runId);
      if (score < ctx.config.get().then(c => c.minScore)) {
        // Mark blocked and save state
        await ctx.issues.update({ issueId, updates: { status: "blocked" } });
        const record = { status: "pending_review", score, logs: [] };
        await ctx.state.set({
          pluginId: ctx.manifest.id,
          scopeKind: "issue",
          scopeId: issueId,
          namespace: "deliverable",
          stateKey: "review"
        }, record);
        await ctx.issues.comment.create({
          issueId,
          content: `Quality gate: score ${score}. Awaiting human review.`
        });
      }
    });

    // 2. Approve action
    ctx.actions.register("approveDeliverable", async ({issueId}) => {
      const stateKey = { pluginId: ctx.manifest.id, scopeKind:"issue", scopeId:issueId, namespace:"deliverable", stateKey:"review" };
      const data = await ctx.state.get(stateKey) as any;
      if (data && data.status === "pending_review") {
        data.status = "approved";
        data.logs.push({ action: "approved", time: new Date().toISOString() });
        await ctx.state.set(stateKey, data);
        await ctx.issues.update({ issueId, updates: { status: "done" }});
        await ctx.activity.log.write({ message: `Deliverable ${issueId} approved.` });
      }
    });

    // 3. Reject action (request revision)
    ctx.actions.register("rejectDeliverable", async ({issueId, reason}) => {
      const stateKey = { pluginId: ctx.manifest.id, scopeKind:"issue", scopeId:issueId, namespace:"deliverable", stateKey:"review" };
      const data = await ctx.state.get(stateKey) as any;
      if (data && data.status === "pending_review") {
        data.status = "needs_revision";
        data.rejection = reason || "";
        data.logs.push({ action: "rejected", reason, time: new Date().toISOString() });
        await ctx.state.set(stateKey, data);
        // Allow agent to fix: set back to ToDo or In Progress
        await ctx.issues.update({ issueId, updates: { status: "todo" }});
        await ctx.issues.comment.create({
          issueId,
          content: `Deliverable needs revision: ${reason}`
        });
      }
    });

    // 4. Provide data to UI
    ctx.data.register("deliverableStatus", async ({ issueId }) => {
      const key = { pluginId: ctx.manifest.id, scopeKind:"issue", scopeId:issueId, namespace:"deliverable", stateKey:"review" };
      const rec = await ctx.state.get(key) as any;
      return rec || { status: "none", score: null };
    });
  }
});
```

This pseudocode shows the main logic. It assumes `agent.run.finished` events include an `issueId`. On low score it blocks the task and saves state. The UI actions read/update that state. All state writes use `ctx.state` and all issue changes use `ctx.issues` APIs (which require the declared capabilities【32†L1029-L1036】). This keeps core governance intact (the plugin never grants a task “permission” it shouldn’t have; it just uses normal issue updates and comments).

## Architectural Notes & Risks

- **Event Payloads:** Currently, `issue.created` events include limited data (title/identifier only)【52†L225-L233】, so plugin may need to fetch full issue details via API. The same may apply to `agent.run.finished`. We may rely on context (like event payload or context object) to get `issueId`. Some adapter implementations may be needed to surface the deliverable content to the plugin.  
- **Approval vs. Task States:** We avoid using Paperclip’s built-in *Approval* objects (which are designed for hires/strategy) and instead use task status and plugin state. This means board members approve via the plugin UI, not the core approvals list. This sidesteps forbidden “approval.decide” capabilities【32†L1067-L1075】. However, it also means approvals won’t appear in the global Approvals UI. If integration with core approvals is needed, the plugin could POST to the core API (with `http.outbound`) to create an approval request of a custom type – but that lies outside MVP scope.  
- **Persistent State:** We use `ctx.state` for simplicity. For richer queries or multiple fields, a plugin could also use `ctx.entities.upsert` (plugin-owned database records) to store each deliverable record. But for MVP, `ctx.state` suffices【32†L1039-L1043】.  
- **Concurrency & Retries:** The plugin must handle “at least once” events【16†L845-L853】, so handlers should be idempotent. For example, checking if state already exists before re-applying. We should ensure the same deliverable isn’t processed twice.  
- **UI Trust Model:** Note that plugin UI runs as trusted code (same origin)【10†L285-L294】, so we can rely on it calling our `performAction` and `getData`. We need not sandbox the UI.  

In summary, the plugin-based design cleanly uses Paperclip’s extension points. The manifest ties together the worker and UI. The worker listens to domain events, mutates tasks and state, and the UI presents the review interface. This achieves a “universal external-deliverable gate” without modifying core code, using only supported plugin capabilities【13†L609-L618】【32†L1039-L1043】.

**Sources:** Paperclip Plugin SDK & Spec【13†L609-L618】【32†L1029-L1036】【21†L1023-L1030】【18†L1102-L1105】【41†L204-L212】.
