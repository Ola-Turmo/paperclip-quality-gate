# uos-quality-gate

> Universal quality gate plugin for [Paperclip](https://github.com/paperclipai/paperclip).
> v1.0.0 — Public API, semver, tests.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## What

`uos-quality-gate` is a universal, self-service quality gate for the UOS Paperclip ecosystem.
Any agent, department, or reviewer plugin can consume it without coupling.

**Core behavior:** intercepts completed deliverables, scores them against configurable thresholds,
and enforces a human-approval checkpoint before work is marked `done`.

## Protocol

All keys are namespaced under `quality_gate.*`.

### Actions (UI → plugin)

| Action | Params | Description |
|---|---|---|
| `quality_gate.submit` | `issue_id`, `summary?`, `quality_score?`, `block_approval?`, `comment?` | Submit deliverable for review |
| `quality_gate.approve` | `issue_id`, `comment?` | Approve — marks issue `done` |
| `quality_gate.reject` | `issue_id`, `comment` (required) | Reject — marks issue `in_progress` |

### Data (UI → plugin)

| Data key | Returns |
|---|---|
| `quality_gate.review` | `ReviewStatusData` for one issue |
| `quality_gate.reviews` | `ReviewsListData` — all known reviews for a company |
| `quality_gate.config` | Current `QualityGateSettings` thresholds |

### Events subscribed

| Event | When |
|---|---|
| `agent.run.finished` | Agent run completed — auto-triggers quality evaluation |
| `issue.created` | New issue created |
| `issue.updated` | Issue status/details changed |

### Streams emitted

| Channel | Payload |
|---|---|
| `quality_gate.review_created` | `{ review }` |
| `quality_gate.review_updated` | `{ review }` |
| `quality_gate.review_approved` | `{ review }` |
| `quality_gate.review_rejected` | `{ review }` |
| `quality_gate.threshold_breached` | `{ review, score, reason }` |

## Quality Evaluation

```
category:
  score == null           → "none"
  score >= minQualityScore → "passed"           → in_review
  score >= blockThreshold  → "needs_human_review" → in_review / blocked
  score >= autoRejectBelow → "blocked"            → blocked
  score <  autoRejectBelow → "auto_rejected"    → in_progress (auto)

variance: deterministic ±1 based on djb2(category + score)
finalScore = clamp(baseScore + variance, 0, 10)
```

## Configuration (instanceConfigSchema)

| Field | Default | Description |
|---|---|---|
| `minQualityScore` | 7 | Score ≥ this + no blockers → passes auto-gate |
| `blockThreshold` | 5 | Score ≤ this or `block_approval=true` → needs human review |
| `autoRejectBelow` | 3 | Score < this → auto-rejected, agent must fix and resubmit |

## Agent Tools

### `quality_gate_review`

Check review status for an issue. Does not modify state.

```
issue_id: string          (required)
include_checks: boolean   (default: false)
```

### `submit_for_review`

Submit a completed deliverable for review.

```
issue_id:      string
summary?:       string
quality_score?: number   (0-10)
block_approval?: boolean
comment?:       string
```

## Integration (for other UOS plugins)

```ts
// Call the quality gate from any plugin
const result = await ctx.actions.invoke("quality_gate.submit", {
  issue_id: "iss_xxxx",
  summary: "Implemented user auth",
  quality_score: 7,
  block_approval: false,
});

// Subscribe to review events from other plugins
ctx.streams.on("quality_gate.review_approved", async ({ review }) => {
  ctx.logger.info("Deliverable approved", { issueId: review.issueId });
});

// Query review status
const data = await ctx.data.get("quality_gate.review", { issueId: "iss_xxxx" });
```

## Development

```bash
# Install
npm install

# Type check
npm run plugin:typecheck

# Build
npm run plugin:build

# Smoke test
npm test

# Dev (watch)
npm run plugin:dev
```

## Versioning

- **Semver** from v1.0.0 — patch = bugfix, minor = additive, major = breaking
- Protocol (action/data keys, event channels, payload shapes) is the public API
- Breaking changes require a major version bump + migration guide

## Architecture

```
src/
├── manifest.ts   — Plugin manifest (capabilities, tools, UI slots, config schema)
├── worker.ts      — Plugin worker (actions, tools, events, data registrations)
├── types.ts       — TypeScript interfaces
├── helpers.ts     — Pure functions (evaluation, comment building, state helpers)
└── ui/
    ├── index.tsx           — UI entry point
    └── QualityGateTab.tsx  — Issue detail tab UI
```

## License

MIT — turmo.dev
