# PAR-52 Status: uos-quality-gate npm publish

**Issue:** PAR-52 - Publish uos-quality-gate as public npm package
**Status:** 90% complete - npm publish pipeline ready, blocked by NPM_TOKEN

## What is complete

- package.json: `private: false`, `version: 2.1.0`, description set ✓
- CI passes (prettier formatting fixed) ✓
- publish.yml GitHub Actions workflow configured ✓
- Workflow builds successfully (dist/worker.js 309kb, dist/ui/index.js 83kb) ✓
- Tag v2.1.0 pushed to GitHub and workflow triggered ✓

## Blocker

**NPM_TOKEN GitHub secret is missing/empty.**
Workflow run 25136213470 shows `NODE_AUTH_TOKEN:` is empty.
`npm publish --access public` requires npm authentication.

## How to unblock (one-time human action)

1. Go to https://www.npmjs.com — create account if needed
2. Profile → Access Tokens → Create Classic Token (Publish scope)
3. Go to https://github.com/Ola-Turmo/paperclip-quality-gate/settings/secrets/actions
4. New repository secret: Name=`NPM_TOKEN`, Value=`<token from step 2>`
5. Push tag to re-trigger: `git tag v2.1.0 && git push origin v2.1.0`

## Verification after unblock

```bash
npm show uos-quality-gate
# Expected: version: 2.1.0, description, license info
npm install uos-quality-gate
# Expected: installs without 404
```

## Acceptance criteria from PAR-52

- `npm show uos-quality-gate` returns valid metadata — waiting on NPM_TOKEN
- `npm install uos-quality-gate` installs without 404 — waiting on NPM_TOKEN
- PAR outreach can link to https://www.npmjs.com/package/uos-quality-gate — waiting on NPM_TOKEN
