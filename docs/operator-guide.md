# Operator Guide

## When to use the gate

Use UOS Quality Gate when an autonomous agent or operator-generated draft needs a human decision before downstream release.

Examples:

- outbound messaging drafts
- agent-generated customer responses
- issue-resolution summaries
- content or workflow outputs that require auditability

## What the reviewer sees

The detail tab presents:

- current review status
- release state
- display and decision scores
- confidence signal
- draft artifact body
- risk flags
- evidence refs and trace
- next-step template
- reviewer timeline

The company-level queue page and dashboard widget present:

- pending review counts
- approved-hold vs released package counts
- high-risk package alerts
- reviewer ownership gaps
- bulk triage controls

## Recommended reviewer flow

### Approve and hold

Use **Approve** when the work is acceptable but the final downstream release should wait for a separate coordination step.

### Approve and release

Use **Approve & Release** when the deliverable is ready to leave the review lane.

### Request revision

Use **Request revision** when the submission needs changes but should remain with the same team or owner.

### Return to agent

Use **Return to agent** when the responsible Paperclip agent should receive a structured revision brief.

### Escalate

Use **Escalate** when a higher-scope reviewer, manager, or risk owner should take over the decision.

## Interpreting scores

- **Display score** is the reviewer-facing rendered score.
- **Decision score** is the threshold-driving score after structured-check bonuses.
- **Risk flags** should always be reviewed alongside scores.

## Best practices

- prefer explicit reviewer notes over silent approvals
- use the next-step template when requesting revisions
- treat the evidence hash and issue documents as the source of audit truth
- regenerate next-step guidance when context changes materially
