# uos-quality-gate — Specification

> Universal quality gate plugin for [Paperclip](https://github.com/paperclipai/paperclip).
> v1.0.0 — Public API, semver, no breaking changes without major version bump.

---

## 1. Purpose

`uos-quality-gate` is a universal, self-service quality gate for the UOS ecosystem.
Any agent, department, or reviewer plugin can consume it without coupling.

**What it does:** intercepts completed deliverables, scores them against configurable
thresholds, and enforces a human-approval checkpoint before work is marked `done`.

**What it does NOT do:** host a review UI (Paperclip provides that), manage issues,
or run agents. Those are owned by other plugins or by Paperclip itself.

---

## 2. Protocol — Plugin API Surface

All namespaced under `quality_gate.*`. All payloads are versioned.

### 2.1 Actions (bridge: UI → plugin worker)

| Action key | Trigger | Description |
|---|---|---|
| `quality_gate.submit` | reviewer / agent | Submit a deliverable for quality review |
| `quality_gate.approve` | reviewer | Approve a deliverable — marks issue `done` |
| `quality_gate.reject` | reviewer | Reject a deliverable — marks issue `in_progress` |

#### `quality_gate.submit`

```ts
// params
{
  issue_id:      string;   // required
  summary?:      string;   // deliverable summary (from agent)
  quality_score?: number;  // 0-10 agent self-assessed score
  block_approval?: boolean; // true = force human review regardless of score
  comment?:      string;   // optional reviewer comment
}
```

#### `quality_gate.approve`

```ts
{ issue_id: string; comment?: string }
```

#### `quality_gate.reject`

```ts
{ issue_id: string; comment: string }
```

### 2.2 Data (bridge: UI widget → plugin worker)

| Data key | Returns |
|---|---|
| `quality_gate.review` | `ReviewStatusData` for one issue |
| `quality_gate.reviews` | `ReviewStatusData[]` for all known reviews |
| `quality_gate.config` | Current `QualityGateSettings` |

### 2.3 Events subscribed (plugin ← Paperclip host)

| Event | When |
|---|---|
| `issue.created` | New issue created |
| `issue.updated` | Issue status/details changed |
| `agent.run.finished` | Agent run completed — **auto-triggers quality evaluation** |
| `agent.run.failed` | Agent run crashed — log and skip auto-gate |

### 2.4 Streams emitted (plugin → Paperclip host / other plugins)

| Channel | Payload |
|---|---|
| `quality_gate.review_created` | `{ review: DeliverableReview }` |
| `quality_gate.review_updated` | `{ review: DeliverableReview }` |
| `quality_gate.review_approved` | `{ review: DeliverableReview }` |
| `quality_gate.review_rejected` | `{ review: DeliverableReview }` |
| `quality_gate.threshold_breached` | `{ review: DeliverableReview; score: number }` |

Any other plugin can subscribe to these channels via `ctx.streams.on`.

---

## 3. State Model

Reviews are stored at **per-issue scope**:

```
{ scopeKind: "issue", scopeId: <issueId>, stateKey: "review" }
  → DeliverableReview
```

This is fully atomic. Concurrent reviews on different issues never contend.

The plugin also stores a company-level index of known review IDs:

```
{ scopeKind: "company", scopeId: <companyId>, stateKey: "review_ids" }
  → string[]  (ordered by last-updated)
```

---

## 4. Review Lifecycle

```
issue.created
    │
    ▼
[no review] ───────────────────────────────────────────────────────┐
                                                                │
                                                        (quality_gate.submit called)
                                                                │
                                                                ▼
                                                        pending_review
                                                                │
                                        ┌────────────────────────┴────────────────────────┐
                                        │                                                 │
                               agent.run.finished                                 manual submit
                              (auto-evaluate)                                         │
                                        │                                                 │
                                        ▼                                                 ▼
                              ┌──────────────┐      ┌─────────────────┐    ┌──────────────────────┐
                              │ score ≥ min  │      │ score < min     │    │ block_approval=true  │
                              │ no blockers  │      │ no blockers     │    │ (any score)          │
                              └──────┬───────┘      └────────┬────────┘    └──────────┬───────────┘
                                     │                      │                       │
                                     ▼                      ▼                       ▼
                              in_review             auto-rejected            needs_human_review
                              (await human)        (in_progress)             (blocked)
                                     │                      │                       │
                        ┌────────────┴────────────┐         │                       │
                        │                         │         │                       │
               approve_deliverable          reject          │                       │
                        │                         │         │                       │
                        ▼                         ▼         │                       │
                      done                  in_progress      │                       │
                                                   (agent    │                       │
                                                    must fix)│                       │
                                                                 │                       │
                                                          submit ──┘
```

---

## 5. Evaluation Algorithm

`evaluateQuality(score, config)`:

```
category:
  score == null          → "none"
  score >= min           → "passed"
  score >= blockThreshold → "needs_human_review"
  score >= autoRejectBelow → "blocked"
  score <  autoRejectBelow → "auto_rejected"

variance: deterministic ±1 from djb2(category + string(score))
finalScore: clamp(baseScore + variance, 0, 10)
```

Evaluation always runs deterministically — same inputs always produce same outputs.

---

## 6. Tool Definitions (for Paperclip agents)

### `quality_gate_review`

```
name:        quality_gate_review
description: Check quality gate review status for a Paperclip issue.
parameters:
  issue_id: { type: string, required: true }
  include_checks: { type: boolean, default: false }
```

### `submit_for_review`

```
name:        submit_for_review
description: Submit a completed deliverable for quality gate review.
parameters:
  issue_id:      { type: string, required: true }
  summary:       { type: string }
  quality_score: { type: number }
  block_approval: { type: boolean }
  comment:       { type: string }
```

---

## 7. Configuration (instanceConfigSchema)

```ts
interface QualityGateSettings {
  minQualityScore:   number;  // default 7
  blockThreshold:    number;  // default 5
  autoRejectBelow:   number;  // default 3
}
```

---

## 8. Versioning Policy

- **Semver** from v1.0.0 — patch = bugfix, minor = additive, major = breaking
- Protocol (action/data keys, event channels, payload shapes) is the public API
- Internal helpers, state key names, and implementation details may change
- Breaking changes to the protocol require a major version bump + migration guide

---

## 9. Error Handling

| Error | Behavior |
|---|---|
| Issue not found | `{{ ok: false, error: "Issue not found" }}` |
| Review not found | `{{ ok: false, error: "No review found for this issue" }}` |
| Already approved | `{{ ok: true, message: "Already approved" }}` — idempotent |
| Already rejected | `{{ ok: true, message: "Already rejected" }}` — idempotent |
| SDK error (API call fails) | Log + return `{{ ok: false, error: "..." }}` — never throw |

---

## 10. Integration Contract

Other UOS plugins consume `uos-quality-gate` by:

1. **Calling actions**: `ctx.actions.invoke("quality_gate.submit", { issue_id, ... })`
2. **Subscribing to streams**: `ctx.streams.on("quality_gate.review_approved", handler)`
3. **Querying data**: `ctx.data.get("quality_gate.review", { issueId })`
4. **Declaring dependency** in their manifest: no formal dependency system yet — rely on `uos-quality-gate` being installed

---

## 11. Canonical Source of Truth

`github.com/Ola-Turmo/uos-quality-gate` — all other copies are mirrors.

