# Parallel Company AI — Agent Learning Log

## npm Publish Blocker (2026-04-29)

### Issue

PAR-52: Publish uos-quality-gate v2.1.0 to public npm registry.

### State

- package.json: public, v2.1.0 ✓
- CI: passes ✓
- publish.yml workflow: configured, builds, fails on publish due to empty NPM_TOKEN ✓
- GitHub secret NPM_TOKEN: exists but empty (needs real token value) ✓

### Exact Blocker

`gh run view 25136213470` shows:

```
NODE_AUTH_TOKEN:   ← empty, NPM_TOKEN secret not set
npm publish --access public → 401 Unauthorized
```

### One-Step Unblock

Human operator adds real npm token value to GitHub secret:

```bash
# 1. Get npm publish token at https://www.npmjs.com/settings/tokens
# 2.
gh secret set NPM_TOKEN --repo Ola-Turmo/paperclip-quality-gate
# (paste token when prompted)
# 3. Trigger publish:
git tag v2.1.0 && git push origin v2.1.0
```

### Verification

```bash
npm show uos-quality-gate  # should show v2.1.0
```

## Run-Scoped Auth Issue (Known)

Paperclip run-scoped auth (X-Paperclip-Run-Id header) fails for ALL write operations:

- POST /api/companies/.../issues → 401
- POST /api/issues/.../comments → 401
- PUT /api/companies/.../memory/... → 401
  This is a systematic Paperclip issue; reads work, writes don't with this auth method.
  Workaround: push status files to GitHub repo for next agent to read.

## 2026-05-07: Agent.run.finished Auto-Trigger Gap Fixed

### Problem
The `agent.run.finished` event handler often failed to create a review because:
1. `executionRunId`/`checkoutRunId` on the Issue may be cleared before/during the event
2. The handler assumed Paperclip sent plugin-specific payload fields (`qualityScore`, `summary`, `blockApproval`, `agentId`) which are not guaranteed

### Solution
- Added `agent.run.started` handler to index `runId → issueId` in run-scoped plugin state
- Added `findIssueIdForRun` helper: checks run index first, then falls back to scanning issues by `executionRunId`, `checkoutRunId`, and `originRunId`
- Made `handleAgentRunFinished` defensive: safely extract optional payload fields, fallback to `event.actorId` for `agentId`
- Clean up run index after `agent.run.finished` and `agent.run.failed`

### Evidence
- Commit: `b593139` on `main`
- Files changed: `src/events.ts`, `src/helpers.ts`, `src/types.ts`, `tests/events.test.ts`
- Tests: 19 pass (8 suites), typecheck + lint + format clean
- GitHub: https://github.com/Ola-Turmo/paperclip-quality-gate/commit/b593139

### Next Steps
- Monitor Paperclip plugin logs after next deployment to confirm reviews auto-create on agent runs
- Consider adding `agent.run.cancelled` handler for completeness
