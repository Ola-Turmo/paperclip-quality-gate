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
