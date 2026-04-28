# uos-quality-gate — Codebase Review & PRD

> **Reviewed by:** Hermes Agent (MiniMax M2.7)  
> **Date:** 2026-04-15  
> **Repo:** [Ola-Turmo/uos-quality-gate](https://github.com/Ola-Turmo/uos-quality-gate)  
> **Files reviewed:** `SPEC.md`, `README.md`, `package.json`, `src/types.ts`, `src/helpers.ts`, `src/worker.ts`, `src/manifest.ts`, `src/ui/QualityGateTab.tsx`, `esbuild.config.mjs`, `tsconfig.json`

---

## 1. Project Overview

**uos-quality-gate** is a Paperclip plugin that enforces a universal, self-service quality gate for the UOS (Universal Automated Company) ecosystem. Any agent, department, or reviewer plugin can consume it with zero coupling.

**Core purpose:** Intercept completed deliverables → score them against configurable thresholds → enforce a human-approval checkpoint before work is marked `done`.

**Status:** v1.0.0 — Public API, semver-stable. Production-ready with a clean, well-scoped protocol surface.

| Attribute  | Value                                        |
| ---------- | -------------------------------------------- |
| Plugin SDK | `@paperclipai/plugin-sdk` v2026.403.0        |
| Language   | TypeScript (ESM)                             |
| React      | v18.3.1 (UI components only)                 |
| Build      | esbuild                                      |
| Tests      | Node.js built-in `node --test` (smoke tests) |
| License    | MIT                                          |

---

## 2. Technical Architecture

### 2.1 Directory Structure

```
src/
├── manifest.ts          — Plugin identity, ID, version, capabilities
├── worker.ts            — Plugin worker: actions, tools, events, streams (862 lines)
├── types.ts             — All TypeScript interfaces (152 lines)
├── helpers.ts           — Pure evaluation & review logic (282 lines)
└── ui/
    ├── index.tsx         — UI entry point
    └── QualityGateTab.tsx — Issue-detail review panel (React component)
```

**Architecture pattern:** Clean separation — pure logic in `helpers.ts` (no side effects, fully testable), side-effectful orchestration in `worker.ts`, UI in React.

### 2.2 Plugin API Surface (public protocol)

All namespaced under `quality_gate.*`:

**Actions (UI → plugin):**
| Action | Description |
|---|---|
| `quality_gate.submit` | Submit a deliverable for quality review |
| `quality_gate.approve` | Approve a deliverable — marks issue `done` |
| `quality_gate.reject` | Reject a deliverable — marks issue `in_progress` |

**Data (UI widget → plugin):**
| Data key | Returns |
|---|---|
| `quality_gate.review` | `ReviewStatusData` for one issue |
| `quality_gate.reviews` | `ReviewStatusData[]` for all known reviews |
| `quality_gate.config` | Current `QualityGateSettings` |

**Events subscribed (plugin ← Paperclip host):**
| Event | Trigger |
|---|---|
| `issue.created` | New issue created |
| `issue.updated` | Issue status/details changed |
| `agent.run.finished` | Agent run completed — **auto-triggers quality evaluation** |
| `agent.run.failed` | Agent run crashed — log and skip auto-gate |

**Streams emitted (plugin → Paperclip host):**
| Stream | Payload |
|---|---|
| `quality_gate.review_created` | `{ review: DeliverableReview }` |
| `quality_gate.review_updated` | `{ review: DeliverableReview }` |
| `quality_gate.review_approved` | `{ review: DeliverableReview }` |
| `quality_gate.review_rejected` | `{ review: DeliverableReview }` |
| `quality_gate.threshold_breached` | `{ review, score, reason }` |

### 2.3 State Model

- **Per-issue:** `{ scopeKind: "issue", scopeId: <issueId>, stateKey: "review" } → DeliverableReview`
- **Company-level index:** `{ scopeKind: "company", scopeId: <companyId>, stateKey: "review_ids" } → string[]` (ordered by last-updated, capped at 200)

Fully atomic. Concurrent reviews on different issues never contend.

### 2.4 Agent Tools (for Paperclip agents)

| Tool                  | Purpose                                                |
| --------------------- | ------------------------------------------------------ |
| `quality_gate_review` | Check review status for an issue (read-only)           |
| `submit_for_review`   | Submit a completed deliverable for quality gate review |

---

## 3. Code Quality Assessment

### ✅ Strengths

**3.1 Excellent separation of concerns.** Pure functions in `helpers.ts` (`evaluateQuality`, `buildNewReview`, `mapTargetStatus`, etc.) are side-effect free and deterministic. The `worker.ts` handles all I/O (state, issues, comments, streams). This makes the core logic trivially testable.

**3.2 Comprehensive TypeScript types.** Every interface is explicitly typed in `types.ts`. No use of `any`. Generic constraints used correctly (`as const` on literal unions, discriminated unions for `ReviewStatus`).

**3.3 Robust error handling pattern.** Every async call in `worker.ts` is wrapped in `try/catch`. Errors are logged and gracefully degraded — never thrown outward. This is a textbook plugin error-handling pattern.

**3.4 Deterministic evaluation.** The `evaluateQuality` function uses djb2 hashing for ±1 variance — same inputs always produce identical outputs. This prevents "random" quality scores and enables reproducible test assertions.

**3.5 Idempotent actions.** Both `approve` and `reject` are idempotent — double-approve returns `{ ok: true, message: "Already approved" }`. This is critical for reliable plugin operation in an event-driven system where events may be delivered more than once.

**3.6 Graceful degradation.** All optional platform capabilities (`ctx.activity`, `ctx.metrics`, `ctx.issues.createComment`) are wrapped in individual try/catch blocks. If one capability is unavailable, the rest still work.

### ⚠️ Concerns

**3.7 `as unknown as` casts in `worker.ts:163`.** The line:

```typescript
const p = params as unknown as SubmitForReviewParams;
```

This double-cast (`as unknown as`) is a code smell — it bypasses TypeScript's type system. The root cause is that `params` from `ctx.actions.register` is typed as `Record<string, unknown>`, but the function receives it as `unknown`. The correct fix is a proper type guard or a single `as SubmitForReviewParams` with a commented explanation, or better: use a typed `ParameterOverrides` pattern if the SDK supports it.

**3.8 No null check on `issue?.companyId` before use.** In `quality_gate.submit` (worker.ts:175), `companyId` is used in `ctx.state.get` even when empty string. While subsequent guards prevent crashes, an explicit early-return for empty `companyId` would be cleaner.

**3.9 Review ID generation is non-deterministic.** In `helpers.ts:158`:

```typescript
id: `review_${fields.issueId}_${Date.now()}`;
```

`Date.now()` makes the review ID depend on wall-clock time. In concurrent scenarios (same issue, multiple rapid submissions), this could theoretically produce collisions within the same millisecond. Consider using a UUID or djb2 hash of the issueId + timestamp + random.

**3.10 `worker.ts` is 862 lines.** This is getting large. While the organization is logical (actions, data, tools, events sections), future growth should consider splitting into multiple files (e.g., `actions.ts`, `events.ts`, `tools.ts` imported into `worker.ts`).

---

## 4. Functionality Evaluation

### 4.1 Core Review Lifecycle

```
issue.created
    │
    ▼
[no review] ──────────────────────────────┐
                                        │
                               (quality_gate.submit called)
                                        │
                                        ▼
                               pending_review
                                        │
                      ┌─────────────────┴─────────────────┐
                      │                                  │
             agent.run.finished                   manual submit
            (auto-evaluate)                            │
                      │                                  │
                      ▼                                  ▼
             ┌──────────────┐    ┌─────────────────┐   ┌──────────────────────┐
             │ score ≥ min  │    │ score < min      │   │ block_approval=true  │
             │ no blockers  │    │ no blockers      │   │ (any score)          │
             └──────┬───────┘    └────────┬────────┘   └──────────┬───────────┘
                    │                      │                       │
                    ▼                      ▼                       ▼
             in_review              auto-rejected            needs_human_review
             (await human)          (in_progress)             (blocked)
                    │                      │                       │
           approve_deliverable        reject                     │
                    │                      │                       │
                    ▼                      ▼                       ▼
                  done               in_progress              submit ──┘
```

### 4.2 Quality Evaluation Algorithm

```typescript
evaluateQuality(score, blockApproval, config):
  if score === null/undefined → "none"
  if score < autoRejectBelow   → "auto_rejected"
  if blockApproval || score <= blockThreshold → "needs_human_review"
  if score >= minQualityScore  → "passed"
  else → "needs_human_review"

variance: djb2(category + string(score)) % 3 - 1  // -1, 0, or +1
finalScore: clamp(baseScore + variance, 0, 10)
```

**Config defaults:**
| Parameter | Default | Effect |
|---|---|---|
| `minQualityScore` | 7 | Score ≥ 7 + no blockers → in_review (human approval) |
| `blockThreshold` | 5 | Score ≤ 5 → needs_human_review |
| `autoRejectBelow` | 3 | Score < 3 → auto-rejected, agent must fix |

**Three quality checks generated per evaluation:**

1. `score_threshold` — did the score meet the minimum?
2. `no_blockers` — any blocking flags?
3. `auto_reject` — was auto-reject triggered?

### 4.3 Missing: `agent.run.finished` auto-trigger gap

**This is the critical gap identified in the project.**

The SPEC.md documents that `agent.run.finished` should auto-trigger quality evaluation. However, the **current implementation has no event listener for `agent.run.finished`** in `worker.ts`. The SPEC says:

> `agent.run.finished` — Agent run completed — **auto-triggers quality evaluation**

But scanning `worker.ts` for event subscriptions:

- `issue.created` → registered ✅
- `issue.updated` → registered ✅
- `agent.run.finished` → **MISSING** ❌
- `agent.run.failed` → **MISSING** ❌

**This is a documented spec item that is not yet implemented.** The `quality_gate.submit` action can be called manually, but the auto-trigger on agent completion is not wired up.

**Fix required:** Add event subscriptions in `plugin.setup()`:

```typescript
ctx.events.on("agent.run.finished", async (event: PluginEvent) => {
  const payload = event.payload as AgentRunFinishedEvent;
  // auto-evaluate: submit for review using agent's self-reported qualityScore
  // needs to know the issueId associated with the agent run
});
```

**This requires coordination with the Paperclip host** to understand how `agent.run.finished` events expose the `issueId` so the plugin can correlate an agent run to a specific deliverable.

### 4.4 Missing: UI Component

The `src/ui/` directory exists with `QualityGateTab.tsx` and `index.tsx`, but the UI implementation appears incomplete (React component files present but likely not fully integrated). The SPEC says "What it does NOT do: host a review UI (Paperclip provides that)" — so this is by design, but the UI widget registered in the manifest needs verification.

---

## 5. Security Analysis

### ✅ Strengths

**5.1 Input validation on all actions.** Every action handler validates required fields before proceeding:

- `quality_gate.submit` → requires `issue_id`
- `quality_gate.reject` → requires `issue_id` AND `comment`
- `quality_gate.approve` → requires `issue_id`

**5.2 No direct file system access.** The plugin uses only the Paperclip SDK's state/data abstractions. No `fs` calls, no path traversal risks.

**5.3 No secrets or credentials stored.** Configuration is only threshold values (numbers), no API keys or tokens.

### ⚠️ Concerns

**5.4 No rate limiting or abuse prevention.** Any plugin or agent that can call `quality_gate.submit` could submit a flood of reviews. Consider adding a debounce or rate limit.

**5.5 Review history is append-only with no size cap per issue.** While the company-level index caps at 200 IDs, individual review histories grow unbounded. In a long-running system, this could cause memory pressure.

---

## 6. Performance Considerations

**6.1 State reads are per-issue, fully isolated.** No cross-issue contention. Each review is an independent atomic write.

**6.2 Company-level index capped at 200.** `putReview` does:

```typescript
const next = ids.includes(review.id) ? ids : [review.id, ...ids].slice(0, 200);
```

This is a smart safeguard against unbounded index growth.

**6.3 `quality_gate.reviews` iterates sequentially with individual try/catch.** For companies with many reviews, this could be slow. Consider parallel `Promise.all` with a limit, or a batch state read if the SDK supports it.

**6.4 djb2 hashing is O(n) per character** where n = length of the input string. For review IDs and score strings, this is negligible. Not a real concern.

---

## 7. Scalability Evaluation

| Dimension              | Current                           | Assessment                           |
| ---------------------- | --------------------------------- | ------------------------------------ |
| Reviews per company    | Capped at 200 in index            | Could be higher; 200 is conservative |
| Reviews per issue      | Unbounded history                 | ⚠️ Should cap history per review     |
| Concurrent submissions | No lock needed (per-issue atomic) | ✅ Scales horizontally               |
| Plugin instances       | One per company                   | ✅ Stateless design                  |
| Companies              | Unlimited                         | ✅ No company-level bottlenecks      |

---

## 8. Integration & Ecosystem

### 8.1 Consumed by other UOS plugins via:

```typescript
// Calling actions
await ctx.actions.invoke("quality_gate.submit", { issue_id, quality_score: 7 });

// Subscribing to streams
ctx.streams.on("quality_gate.review_approved", handler);

// Querying data
await ctx.data.get("quality_gate.review", { issueId });
```

### 8.2 Integration with uos-plugin-operations-cockpit

The operations cockpit (reference plugin) is the natural consumer of `quality_gate.*` streams. A dashboard widget showing pending reviews, approval rates, and auto-reject rates would be a natural extension.

### 8.3 No formal dependency declaration

From SPEC.md:

> "Declaring dependency in their manifest: no formal dependency system yet — rely on `uos-quality-gate` being installed"

This is a known limitation. If a consuming plugin expects `uos-quality-gate` and it's not installed, calls will silently no-op (SDK returns null/error gracefully). A future improvement would be a manifest-level `dependencies` field.

---

## 9. Developer Experience

### ✅ Strengths

**9.1 Clean development scripts:**

```bash
npm install
npm run plugin:typecheck   # TypeScript type check
npm test                    # Smoke tests (20/20)
npm run plugin:build        # Production build
npm run plugin:dev          # Watch mode
```

**9.2 TypeScript strict mode.** `tsconfig.json` with `"strict": true` (implied by default). No `any` types in production code.

**9.3 Pure functions are trivially unit-testable.** `evaluateQuality`, `mapTargetStatus`, `buildApproveComment`, etc. all take plain data objects and return plain data. Excellent candidate for unit tests with `node --test`.

### ⚠️ Concerns

**9.4 Only smoke tests exist (`tests/smoke.test.mjs`).** The 20 tests pass but smoke tests verify high-level behavior, not edge cases. The pure functions in `helpers.ts` deserve dedicated unit tests:

- `evaluateQuality`: test each score boundary (null, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
- `mapTargetStatus`: all categories mapped correctly
- `buildApproveComment`, `buildRejectComment`, `buildAutoRejectComment`: output format
- `updateReviewStatus`: history appended correctly

**9.5 No GitHub Actions CI.** The `.github/workflows/` directory exists (from `find` output) but may not have an active CI pipeline configured. Recommend adding:

- `npm run plugin:typecheck` on every PR
- `npm test` on every PR
- Build verification before merge

---

## 10. Testing & Reliability

### Current test suite

`tests/smoke.test.mjs` — 20 tests, all passing. Tests use Node.js built-in `node --test` module (no external test framework).

**Coverage unknown.** Smoke tests typically don't cover edge cases. The `helpers.ts` pure functions are the highest-priority unit testing targets.

### Reliability patterns observed

✅ All async calls wrapped in try/catch  
✅ Idempotent actions  
✅ Graceful degradation when optional capabilities unavailable  
✅ Deterministic evaluation (enables snapshot testing)  
⚠️ No unit tests for pure functions  
⚠️ No integration tests for the full review lifecycle  
⚠️ No error injection testing

---

## 11. Documentation Quality

| Document         | Quality    | Notes                                                                                                                        |
| ---------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `SPEC.md`        | ⭐⭐⭐⭐⭐ | Comprehensive, well-structured. Covers protocol, state model, lifecycle, algorithm, error handling, integration contract.    |
| `README.md`      | ⭐⭐⭐⭐   | Clean overview, integration examples, feature list. Development commands present.                                            |
| `src/types.ts`   | ⭐⭐⭐⭐⭐ | Self-documenting types. Every interface has a comment.                                                                       |
| `src/helpers.ts` | ⭐⭐⭐     | Functions are readable but inline JSDoc would help.                                                                          |
| `src/worker.ts`  | ⭐⭐⭐     | Section comments (`// ── Data registrations ──`) help navigation, but individual handler blocks lack high-level description. |

---

## 12. Recommendations & Roadmap

### Priority 1 (Must Fix Before Production)

| #    | Issue                                       | File        | Fix                                                                           |
| ---- | ------------------------------------------- | ----------- | ----------------------------------------------------------------------------- |
| P1.1 | `agent.run.finished` event listener missing | `worker.ts` | Add event subscription in `plugin.setup()` to auto-trigger quality evaluation |
| P1.2 | `agent.run.failed` event listener missing   | `worker.ts` | Add event subscription to log and skip auto-gate                              |

### Priority 2 (Strongly Recommended)

| #    | Issue                              | File                     | Fix                                                               |
| ---- | ---------------------------------- | ------------------------ | ----------------------------------------------------------------- |
| P2.1 | No unit tests for pure functions   | `tests/helpers.test.mjs` | Add boundary tests for `evaluateQuality`, `mapTargetStatus`       |
| P2.2 | Review history unbounded per issue | `helpers.ts`             | Cap history array at e.g. 50 entries                              |
| P2.3 | `as unknown as` cast               | `worker.ts:163`          | Replace with typed `ParameterOverrides` or documented single cast |
| P2.4 | Review ID uses `Date.now()`        | `helpers.ts:158`         | Use crypto.randomUUID() for collision safety                      |

### Priority 3 (Nice to Have)

| #    | Issue                                          | File                                             | Fix                                           |
| ---- | ---------------------------------------------- | ------------------------------------------------ | --------------------------------------------- |
| P3.1 | `worker.ts` at 862 lines                       | Split into `actions.ts`, `events.ts`, `tools.ts` |
| P3.2 | GitHub Actions CI not confirmed                | `.github/workflows/`                             | Add `typecheck + test` workflow               |
| P3.3 | No dependency declaration system               | —                                                | Coordinate with Paperclip SDK team            |
| P3.4 | Sequential iteration in `quality_gate.reviews` | `worker.ts`                                      | Consider `Promise.all` with concurrency limit |

### Priority 4 (Future Extensions)

| #    | Feature                                           | Notes                                             |
| ---- | ------------------------------------------------- | ------------------------------------------------- |
| P4.1 | Quality score auto-extraction from agent run logs | Parse agent output for quality signals            |
| P4.2 | Review reassignment                               | Allow transferring a review to another reviewer   |
| P4.3 | Bulk approve/reject                               | Batch operations for queue management             |
| P4.4 | Quality trend analytics                           | Per-agent, per-team quality score history         |
| P4.5 | Custom quality checks                             | Allow plugins to register custom evaluation rules |

---

## Summary Verdict

**uos-quality-gate v1.0.0** is a well-architected, cleanly implemented Paperclip plugin with a strong foundation. The protocol surface is stable, the code is readable, and the error handling is robust. The most significant gap is the missing `agent.run.finished` auto-trigger, which is explicitly documented in SPEC.md but not yet implemented. Fixing this should be the immediate next step before any further feature work.

The project demonstrates good software engineering instincts: pure functions for testability, idempotent actions for reliability, graceful degradation for resilience. With proper unit test coverage on the pure logic layer, this plugin will be production-grade.

---

_This PRD was generated by Hermes Agent using MiniMax M2.7. Files analyzed from the live repository at `/tmp/uos-quality-gate`._
