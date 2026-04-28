# Contributing to uos-quality-gate

Thank you for contributing to the Universal Quality Gate workbench.

## Development Setup

```bash
# Install dependencies
bun install

# Run type checks
bun run plugin:typecheck

# Run tests
bun test

# Lint
bun run lint

# Format check
bun run format:check

# Build
bun run plugin:build
```

## Quality Gate Standards

All PRs must pass the CI quality gate before merge. The quality gate enforces:

- **Type check**: `tsc --noEmit` passes with no errors
- **Lint**: ESLint passes with no errors
- **Format**: Prettier produces no diff
- **Tests**: All smoke and unit tests pass
- **Build**: The plugin bundle compiles without errors

## Commit Message Format

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

feat(ui): add reviewer queue bulk approve
fix(tests): strip .ts import extensions for tsc --noEmit
docs(readme): clarify release decision workflow
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

## Release Process

Releases are gated by the quality gate evidence bundle. The reviewer dashboard must show all quality categories passing before a release decision is approved.
