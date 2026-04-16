# uos-quality-gate

> Universal Quality Gate for the UOS ecosystem — auto-intercepts every agent completion, scores quality, enforces human approval before work is marked done.

---

## tl;dr

```
pnpm install uos-quality-gate
```

Paperclip agents get a zero-configuration quality gate. Every `agent.run.finished` is scored 0–10. High scores auto-pass; low scores get rejected; ambiguous scores demand a human. Zero coupling — any plugin can consume the protocol.

---

## Features

| | |
|---|---|
| **Zero-integration quality enforcement** | Auto-intercepts `agent.run.finished` across all UOS agents |
| **3 built-in checks** | `score_threshold` · `no_blockers` · `auto_reject` + unlimited custom rules |
| **Deterministic scoring** | djb2 variance + weighted scoring — reproducible across runs |
| **Human-in-the-loop** | Score ≥ 7 auto-passes · Score < 3 auto-rejects · Score 3–6 blocked for review |
| **6 real-time streams** | `review_created` · `review_updated` · `review_approved` · `review_rejected` · `review_assigned` · `threshold_breached` |
| **6 actions** | `submit` · `approve` · `reject` · `assign` · `bulk_approve` · `bulk_reject` |
| **4 data keys** | `review` · `reviews` · `config` · `trends` |
| **Full plugin protocol** | `quality_gate.*` actions · data · events · streams — zero coupling |

---

## Workflow

```
┌─────────────────┐      ┌──────────────────────┐
│  AGENT RUN      │      │   QUALITY EVALUATION │
│  FINISHED       │ ───► │   3 built-in checks  │
└─────────────────┘      │   + custom rules     │
                         │   score 0-10         │
                         └──────────┬───────────┘
                                    │
                         ┌──────────▼───────────┐
                         │       score ?        │
                         └──────────┬───────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
         ┌────▼────┐          ┌──────▼──────┐       ┌─────▼─────┐
         │  score  │          │   3 ≤ score │       │  score    │
         │  < 3     │          │   ≤ 6       │       │  ≥ 7      │
         └────┬────┘          └──────┬──────┘       └─────┬─────┘
              │                      │                     │
   ┌──────────▼──────────┐         │            ┌────────▼────────┐
   │ AUTO-REJECTED        │         │            │ AUTO-PASS       │
   │ status: in_progress  │         │            │ status: in_review│
   │ agent must fix      │         │            │ waiting for      │
   └─────────────────────┘         │            │ human approval   │
                                    │            └────────┬────────┘
                         ┌─────────▼─────────────────────▼───┐
                         │          HUMAN REVIEW             │
                         │   reviewer must approve/reject    │
                         └─────────┬────────────────────┬────┘
                                   │                    │
                              ┌────▼────┐           ┌───▼────┐
                              │APPROVED │           │REJECTED│
                              │  DONE   │           │IN PROG │
                              └─────────┘           └────────┘
```

---

## Quick Start

```typescript
import { QualityGate } from "uos-quality-gate";

// Auto-registers on the Paperclip event bus
// Every agent.run.finished is intercepted automatically

// Override thresholds (all optional)
QualityGate.configure({
  minQualityScore: 7,      // default: 7
  blockThreshold: 5,       // default: 5
  autoRejectBelow: 3,      // default: 3
  maxRetries: 3,           // default: 3
});
```

---

## API Reference

### Actions (6)

| Action | Description |
|---|---|
| `quality_gate.submit` | Submit a review for an agent run |
| `quality_gate.approve` | Approve a review |
| `quality_gate.reject` | Reject a review with reason |
| `quality_gate.assign` | Assign a reviewer to a review |
| `quality_gate.bulk_approve` | Bulk-approve multiple reviews |
| `quality_gate.bulk_reject` | Bulk-reject multiple reviews |

### Data Keys (4)

| Key | Description |
|---|---|
| `quality_gate.review` | Single review by `issueId` |
| `quality_gate.reviews` | All reviews (filterable) |
| `quality_gate.config` | Current threshold configuration |
| `quality_gate.trends` | Quality score trends over time |

### Events & Streams (6)

| Stream | Trigger |
|---|---|
| `quality_gate.review_created` | New review submitted |
| `quality_gate.review_updated` | Review state changed |
| `quality_gate.review_approved` | Review approved |
| `quality_gate.review_rejected` | Review rejected |
| `quality_gate.review_assigned` | Reviewer assigned |
| `quality_gate.threshold_breached` | Score crossed threshold |

---

## Architecture

Built on the [Paperclip Plugin SDK](https://github.com/the-claw-bay/paperclip/tree/main/packages/plugins/sdk). Uses the plugin protocol for all actions, data, events, and streams — zero coupling to any specific agent implementation. Any plugin in the UOS ecosystem can consume or extend the quality gate.

---

## Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `minQualityScore` | `number` | `7` | Minimum score to auto-pass |
| `blockThreshold` | `number` | `5` | Score below this → human review required |
| `autoRejectBelow` | `number` | `3` | Score below this → auto-reject |
| `maxRetries` | `number` | `3` | Max resubmit attempts before hard block |

---

## Status

Production-ready. Built for the UOS autonomous agent ecosystem.

<a href="https://github.com/Ola-Turmo/uos-quality-gate/actions"><img src="https://github.com/Ola-Turmo/uos-quality-gate/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
