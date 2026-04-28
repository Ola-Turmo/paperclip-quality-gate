# UOS Quality Gate Specification

Version: 2.1.0

## 1. Purpose

UOS Quality Gate is a Paperclip plugin that converts completed work into a structured, reviewer-ready evidence package.

The product goal is not just to answer “did this score high enough?” but to help an operator answer:

- what was submitted?
- why did the gate fire?
- what evidence supports the current state?
- what is the safest next action?

## 2. Product thesis

A quality gate should be a **reviewable evidence package**, not a single verdict.

Each review therefore stores:

- review trigger metadata
- display score and decision score
- structured checks and risk flags
- draft artifact content
- evidence refs and trace steps
- next-step guidance
- release state
- reviewer timeline

## 3. Public plugin surface

### 3.1 Actions

| Action                            | Purpose                                            |
| --------------------------------- | -------------------------------------------------- |
| `quality_gate.submit`             | Create or refresh a review package                 |
| `quality_gate.approve`            | Approve and release the deliverable                |
| `quality_gate.approve_hold`       | Approve but keep downstream release on hold        |
| `quality_gate.reject`             | Request revision                                   |
| `quality_gate.assign`             | Assign or reassign reviewer ownership              |
| `quality_gate.return_to_agent`    | Send structured revision guidance back to an agent |
| `quality_gate.escalate`           | Escalate the review to a higher-scope lane         |
| `quality_gate.generate_next_step` | Regenerate next-step guidance                      |
| `quality_gate.bulk_approve`       | Bulk approve and release                           |
| `quality_gate.bulk_reject`        | Bulk request revision                              |

### 3.2 Data keys

| Data key               | Returns                                    |
| ---------------------- | ------------------------------------------ |
| `quality_gate.review`  | Single review package for an issue         |
| `quality_gate.reviews` | Recent review packages for a company       |
| `quality_gate.queue`   | Company review queue summary + queue items |
| `quality_gate.config`  | Active threshold config                    |
| `quality_gate.trends`  | Aggregated review/agent trend data         |

### 3.3 Tools

| Tool                  | Purpose                                                        |
| --------------------- | -------------------------------------------------------------- |
| `quality_gate_review` | Read current review status, risks, and optionally checks/trace |
| `submit_for_review`   | Create or refresh a review package from an agent/tool context  |

### 3.4 Event subscriptions

- `agent.run.finished`
- `agent.run.failed`
- `issue.created`
- `issue.updated`

### 3.5 Stream events emitted

- `quality_gate.review_created`
- `quality_gate.review_updated`
- `quality_gate.review_approved`
- `quality_gate.review_rejected`
- `quality_gate.review_assigned`
- `quality_gate.threshold_breached`

## 4. Review lifecycle

```text
submit / agent.run.finished
        ↓
  evaluate quality
        ↓
  build evidence package
        ↓
needs_human_review | pending_review | auto_rejected
        ↓
approve_hold / approve / reject / return_to_agent / escalate
        ↓
persist issue state + comment + evidence docs + telemetry
```

## 5. Decision model

Inputs:

- self-reported quality score
- block approval flag
- configured thresholds
- optional structured checks based on issue metadata

Outputs:

- `inputScore`
- `decisionScore`
- `overallScore`
- `category`
- `checks`
- `riskFlags`
- `summary`

Decision rules:

1. Missing score → manual review lane.
2. Manual block approval → manual review lane.
3. Decision score below `autoRejectBelow` → auto reject.
4. Decision score at or below `blockThreshold` → manual review lane.
5. Decision score at or above `minQualityScore` → reviewer-ready / pass lane.
6. Passed structured checks can add bonus points to the decision score.

## 6. Persistence model

### Issue-scoped state

`stateKey: reviews`

Stores the full `DeliverableReview` object.

### Company-scoped state

`stateKey: review_ids`

Stores recent review IDs for company-level list/trend views.

### Issue documents

The plugin writes two markdown documents back onto the issue:

- `quality-gate-evidence`
- `quality-gate-next-step`

## 7. UI model

The issue detail tab exposes a review cockpit with:

- summary header
- review status chips
- metrics
- draft artifact panel
- operator action bar
- risk flag cards
- evidence bundle panel
- trace + standards section
- return-to-agent controls
- escalation + assignment controls
- timeline

The company-level reviewer surface adds:

- dashboard widget summary
- full-page review queue
- bulk approve and bulk revision actions
- trend sidebar for agent quality performance

## 8. Observability

Every major lifecycle action writes:

- metrics (`quality_gate.<event>`)
- telemetry envelope
- issue comment
- optional activity entry when supported

Telemetry includes:

- company ID
- issue ID
- review ID
- decision type
- review status/category
- display score
- decision score
- review-required signal
- risk count
- released signal

## 9. Security posture

- no secrets are stored in plugin state
- common token and credential patterns are redacted before reviewer comments, evidence markdown, and draft artifacts are persisted
- all side effects are routed through Paperclip host APIs
- issue/document writes are best-effort and error-contained
- dependency audit should be run in CI and during upgrades

## 10. Verification standard

Before release, the project should pass:

- typecheck
- tests
- plugin build
- dependency audit review
- manual UI/doc/image quality pass
