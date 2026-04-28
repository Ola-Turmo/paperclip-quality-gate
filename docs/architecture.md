# Architecture

## Overview

UOS Quality Gate is organized around a small set of focused modules:

| File                                    | Responsibility                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| `src/helpers.ts`                        | Pure scoring, review builders, markdown builders, telemetry envelope             |
| `src/shared.ts`                         | Stateful integration helpers for config, review persistence, issue docs, metrics |
| `src/actions.ts`                        | Operator-triggered mutations                                                     |
| `src/events.ts`                         | Host event subscriptions and auto-review wiring                                  |
| `src/tools.ts`                          | Agent-facing tool entry points                                                   |
| `src/worker.ts`                         | Plugin setup, data registration, worker entrypoint                               |
| `src/ui/QualityGateDashboard.tsx`       | Company-level reviewer queue page                                                |
| `src/ui/QualityGateDashboardWidget.tsx` | Dashboard widget queue summary                                                   |
| `src/ui/QualityGateTab.tsx`             | Reviewer cockpit UI                                                              |
| `src/ui/settings.tsx`                   | Read-only settings/threshold UI                                                  |

## Data flow

```text
agent/tool/operator submit
        ↓
   evaluateQuality()
        ↓
 buildNewReview() / applyEvaluationToReview()
        ↓
 persist issue state + issue documents
        ↓
 issue status/comment/activity/telemetry
        ↓
 detail tab / queue page / widget render review package state
```

## Review object model

The core record is `DeliverableReview`.

It contains:

- lifecycle state (`status`, `category`, `releaseDecision`)
- score model (`qualityScore`, `decisionScore`)
- structured checks
- risk flags
- evidence bundle
- draft artifact
- handoff task
- next-step template
- timeline/history

## Evidence model

The evidence bundle is intentionally small but explicit:

- `inputRefs`
- `retrievedContext`
- `standards`
- `trace`
- `hash`
- `documentKey`

This lets reviewers see what was considered without parsing raw runtime logs.

## Operator actions

All operator actions follow the same broad path:

1. load current review
2. compute updated review state
3. persist review
4. persist markdown artifacts
5. update Paperclip issue status when needed
6. add comment and observability output
7. emit stream event(s)

## Why the design is split this way

- Pure logic is testable in isolation.
- Host API calls are kept out of helper modules.
- UI remains declarative and mostly consumes the review package as-is.
- New actions or new evidence/ref types can be added without reworking the entire worker.
