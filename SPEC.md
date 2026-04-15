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

## 2. Architecture

```
src/
├── manifest.ts       — Plugin identity, ID, version, capabilities
├── worker.ts         — Thin orchestration layer + data registrations (221 lines)
├── actions.ts       — Action handlers: submit / approve / reject / assign / bulk_* (445 lines)
├── events.ts        — Event subscriptions: agent.run.* / issue.* (230 lines)
├── tools.ts         — Agent tools: quality_gate_review / submit_for_review (269 lines)
├── helpers.ts       — Pure evaluation, review building, comment formatting (387 lines)
├── shared.ts        — Runtime helpers needing PluginContext: castParams, getConfig, getReview, putReview
├── types.ts         — All TypeScript interfaces (221 lines)
└── ui/
    ├── index.tsx             — UI entry point
    ├── QualityGateTab.tsx    — Issue-detail review panel (React)
    └── settings.tsx          — Settings panel (React)
```

**Architecture pattern:** Clean separation — pure logic in `helpers.ts` (no side effects, fully testable), side-effectful orchestration in `actions.ts` / `events.ts`, UI in React.

---

## 3. Protocol — Plugin API Surface

All namespaced under `quality_gate.*`. All payloads are versioned.

### 3.1 Actions (bridge: UI → plugin worker)

| Action key | Trigger | Description |
|---|---|---|
| `quality_gate.submit` | reviewer / agent | Submit a deliverable for quality review |
| `quality_gate.approve` | reviewer | Approve a deliverable — marks issue `done` |
| `quality_gate.reject` | reviewer | Reject a deliverable — marks issue `in_progress` |
| `quality_gate.assign` | reviewer | Reassign a review to a different reviewer |
| `quality_gate.bulk_approve` | reviewer | Approve multiple deliverables at once |
| `quality_gate.bulk_reject` | reviewer | Reject multiple deliverables at once |

#### `quality_gate.submit`

```ts
// params
{
  issue_id:      string;   // required
  summary?:      string;   // deliverable summary (from agent)
  quality_score?: number;  // 0-10 agent self-assessed score
  block_approval?: boolean; // true = force human review regardless of score
  comment?:     string;   // optional reviewer comment
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

#### `quality_gate.assign`

```ts
{ issue_id: string; assigned_to: string }
```

Idempotent: reassigning to the same person is a no-op.

#### `quality_gate.bulk_approve`

```ts
{ issue_ids: string[]; comment?: string }
```

Processes up to 5 approvals concurrently.

#### `quality_gate.bulk_reject`

```ts
{ issue_ids: string[]; comment: string }
```

Processes up to 5 rejections concurrently.

### 3.2 Data (bridge: UI widget → plugin worker)

| Data key | Returns |
|---|---|
| `quality_gate.review` | `ReviewStatusData` for one issue |
| `quality_gate.reviews` | `ReviewsListData` for all known reviews |
| `quality_gate.config` | Current `QualityGateSettings` |
| `quality_gate.trends` | `QualityTrendsData` — per-agent analytics |

### 3.3 Events subscribed (plugin ← Paperclip host)

| Event | When |
|---|---|
| `issue.created` | New issue created |
| `issue.updated` | Issue status/details changed |
| `agent.run.finished` | Agent run completed — **auto-triggers quality evaluation** |
| `agent.run.failed` | Agent run crashed — log and skip auto-gate |

### 3.4 Streams emitted (plugin → Paperclip host / other plugins)

| Channel | Payload |
|---|---|
| `quality_gate.review_created` | `{ review: DeliverableReview }` |
| `quality_gate.review_updated` | `{ review: DeliverableReview }` |
| `quality_gate.review_approved` | `{ review: DeliverableReview }` |
| `quality_gate.review_rejected` | `{ review: DeliverableReview }` |
| `quality_gate.threshold_breached` | `{ review: DeliverableReview; score: number }` |

Any other plugin can subscribe to these channels via `ctx.streams.on`.

---

## 4. State Model

Reviews are stored at **per-issue scope**:

```
{ scopeKind: "issue", scopeId: <issueId>, stateKey: "reviews" }
  → DeliverableReview
```

This is fully atomic. Concurrent reviews on different issues never contend.

The plugin also stores a company-level index of known review IDs:

```
{ scopeKind: "company", scopeId: <companyId>, stateKey: "review_ids" }
  → string[]  (ordered by last-updated, capped at 200)
```

---

## 5. Review Lifecycle

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

## 6. Evaluation Algorithm

`evaluateQuality(score, blockApproval, config, issueData?)` returns a `QualityEvaluation`:

```
category:
  score == null/undefined         → "none"
  score <  autoRejectBelow        → "auto_rejected"
  blockApproval || score <= block  → "needs_human_review"
  score >= minQualityScore         → "passed"
  score between block and min      → "needs_human_review"

variant: deterministic ±1 from djb2(category + string(score))
overallScore: clamp(baseScore + variant, 0, 10)

checks:
  - score_threshold  — did the score meet the minimum?
  - no_blockers      — any blocking flags?
  - auto_reject       — was auto-reject triggered?
  - [custom checks]   — from plugin config, evaluated against issue metadata

summary: human-readable quality summary string
autoRejected: boolean
blockThresholdBreached: boolean
passed: boolean
```

Evaluation always runs deterministically — same inputs always produce same outputs.

### Custom Checks

Custom checks are structured rules defined in plugin config (`QualityGateSettings.customChecks`).
Each check is evaluated against the issue's live metadata (labels, title, assignee).

| Check type | Condition |
|---|---|
| `label_required` | Issue has the required label |
| `label_missing` | Issue does NOT have the forbidden label |
| `title_contains` | Issue title contains all specified keywords |
| `has_assignee` | Issue has any assignee |

---

## 7. Configuration (instanceConfigSchema)

```ts
interface QualityGateSettings {
  minQualityScore:   number;        // default 7
  blockThreshold:    number;        // default 5
  autoRejectBelow:    number;        // default 3
  customChecks?:      CustomCheck[]; // structured rules evaluated at every review
}
```

---

## 8. Tool Definitions (for Paperclip agents)

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
  quality_score:  { type: number }
  block_approval: { type: boolean }
  comment:       { type: string }
```

---

## 9. Event Payloads

### `agent.run.finished`

The plugin correlates the `runId` (from `event.entityId`) to an issue by matching
`executionRunId` or `checkoutRunId` on the issue. It then auto-evaluates:

```ts
interface AgentRunFinishedEvent {
  agentId: string;
  status: "completed" | "failed" | "cancelled";
  summary?: string;
  qualityScore?: number;
  blockApproval?: boolean;
}
```

### `agent.run.failed`

```ts
// Logged only — no auto-gate triggered since no deliverable was produced.
```

---

## 10. DeliverableReview Shape

```ts
interface DeliverableReview {
  id:               string;       // format: review_<issueId>_<uuid>
  issueId:          string;
  companyId:        string;
  status:           ReviewStatus;
  qualityScore:     number;       // 0-10 (with ±1 deterministic variance)
  blockApproval:    boolean;
  category:         QualityCategory;
  checks:           QualityCheck[];
  evaluationSummary: string;
  submitterName:    string;
  agentId?:         string;       // set on auto-evaluated reviews
  assignedTo?:      string;       // set by quality_gate.assign
  history:          ReviewAction[]; // capped at 50 entries
  createdAt:        string;       // ISO 8601
  updatedAt:        string;       // ISO 8601
}
```

---

## 11. Trend Analytics

`quality_gate.trends` returns per-agent quality statistics:

```ts
interface AgentTrend {
  agentId:            string;
  displayName:        string;
  avgQualityScore:    number;
  approvedCount:      number;
  rejectedCount:      number;
  autoRejectedCount:  number;
  needsHumanReviewCount: number;
  approvalRate:       number;      // percentage
  autoRejectRate:     number;     // percentage
  totalReviews:       number;
  recentScores?:      { score: number; status: ReviewStatus; createdAt: string }[];
}

interface QualityTrendsData {
  agents:           AgentTrend[];
  overallAvgScore:  number;
  totalReviews:     number;
}
```

Agents with no `agentId` are grouped under `_manual_` (Manual Submission).

---

## 12. Error Handling

| Error | Behavior |
|---|---|
| Issue not found | `{{ ok: false, error: "Issue not found" }}` |
| Review not found | `{{ ok: false, error: "No review found for this issue" }}` |
| Already approved | `{{ ok: true, message: "Already approved" }}` — idempotent |
| Already rejected | `{{ ok: true, message: "Already rejected" }}` — idempotent |
| SDK error (API call fails) | Log + return `{{ ok: false, error: "..." }}` — never throw |

---

## 13. Integration Contract

Other UOS plugins consume `uos-quality-gate` by:

1. **Calling actions**: `ctx.actions.invoke("quality_gate.submit", { issue_id, ... })`
2. **Subscribing to streams**: `ctx.streams.on("quality_gate.review_approved", handler)`
3. **Querying data**: `ctx.data.get("quality_gate.review", { issueId })`
4. **Declaring dependency** in their manifest: no formal dependency system yet — rely on `uos-quality-gate` being installed

---

## 14. Versioning Policy

- **Semver** from v1.0.0 — patch = bugfix, minor = additive, major = breaking
- Protocol (action/data keys, event channels, payload shapes) is the public API
- Internal helpers, state key names, and implementation details may change
- Breaking changes to the protocol require a major version bump + migration guide

---

## 15. Canonical Source of Truth

`github.com/Ola-Turmo/uos-quality-gate` — all other copies are mirrors.
