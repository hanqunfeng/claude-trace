# Documentation

Project-facing usage and CLI reference: [README.md](../README.md) (English) · [README.zh-CN.md](../README.zh-CN.md) (简体中文).

Agent and architecture invariants for AI assistants: [CLAUDE.md](../CLAUDE.md).

## Publishing

| Document | Audience | Summary |
|----------|----------|---------|
| [publishing/oidc.md](publishing/oidc.md) | Maintainers | **Recommended.** Push a `v*` tag; GitHub Actions publishes to npm via OIDC and creates a GitHub Release. |
| [publishing/access-token.md](publishing/access-token.md) | Maintainers | Legacy local `npm publish` using a long-lived npm Access Token in `~/.npmrc`. |

Related scripts:

- `scripts/publish-oidc.sh` — bump version, push tag, watch Actions (see [publishing/oidc.md](publishing/oidc.md))
- `scripts/publish.sh` — local token publish (see [publishing/access-token.md](publishing/access-token.md))

Workflow: [.github/workflows/publish.yml](../.github/workflows/publish.yml)

## CI / GitHub Actions

| Document | Summary |
|----------|---------|
| [github-actions-workflow-guide.md](github-actions-workflow-guide.md) | GitHub Actions concepts, syntax, security, and worked examples; includes a walkthrough of this repo's `ci.yml` and `publish.yml`. |

## Reference

| Document | Summary |
|----------|---------|
| [npm-v12-security-changelog.md](npm-v12-security-changelog.md) | Notes on npm v12 install-time defaults and Granular Access Token deprecation; why OIDC publishing is preferred. |
