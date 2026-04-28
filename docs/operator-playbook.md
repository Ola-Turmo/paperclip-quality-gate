# Operator Playbook

## Who this is for

This guide is for reviewers, operators, and leads who need to decide whether an autonomous output can move forward.

## Standard workflow

### 1. Start in the queue

Open the company-level Quality Gate page or dashboard widget to identify:

- what needs review now
- what is already approved but still on hold
- which packages are high risk
- which pending packages have no owner

Then open the issue-level Quality Gate tab for the specific package that needs action.

### 2. Read the reviewer summary

Use the summary headline and reviewer cue to understand:

- why the gate fired
- what is risky
- what action is expected next

### 3. Inspect the draft artifact

The draft artifact should answer:

- what the system produced
- what source brief or summary it used
- what evaluation summary was generated

### 4. Check the risk flags

Risk flags are the fastest way to understand whether the package is:

- safe to release
- missing evidence
- waiting for assignment
- blocked on compliance or policy concerns

### 5. Review the evidence bundle

Use the evidence bundle to validate:

- the triggering issue
- the submitted summary
- retrieved context
- labels or assignment context
- the trace hash

### 6. Choose the operator action

#### Approve

Use when the package is acceptable but downstream release should still wait.

#### Approve & Release

Use when the content and downstream context are both ready.

#### Request revision

Use when the content should be revised before another review pass.

#### Return to agent

Use when you want the responsible agent to continue with explicit structured instructions.

#### Escalate

Use when the package needs higher-scope review, policy sign-off, or leadership attention.

## Recommended decision rules

### Use Approve & Release when

- evidence is complete
- no unresolved high-risk flags remain
- the target destination is known
- downstream release is appropriate now

### Use Approve + Hold when

- content is good
- release timing or destination is not ready yet
- a human still needs to coordinate the next operational step

### Use Request Revision when

- facts are incomplete
- wording is weak or risky
- checks failed in a way the current reviewer can describe clearly

### Use Return to Agent when

- an agent should continue the work
- you have a concrete next-step brief
- the output is recoverable without leadership intervention

### Use Escalate when

- legal, brand, privacy, or security concerns exist
- the wrong reviewer owns the decision
- there is ambiguity about whether the content should ever be released

## What to expect after each action

| Action            | Host issue status | Release state   |
| ----------------- | ----------------- | --------------- |
| Approve + Hold    | `in_review`       | `approved_hold` |
| Approve & Release | `done`            | `released`      |
| Request revision  | `in_progress`     | `rejected`      |
| Return to agent   | `in_progress`     | `rejected`      |
| Escalate          | `blocked`         | `escalated`     |

## Audit trail

Every important step writes to one or more of:

- issue comment
- issue document
- plugin state
- activity log
- metrics / telemetry

That makes the final decision reconstructible later.
