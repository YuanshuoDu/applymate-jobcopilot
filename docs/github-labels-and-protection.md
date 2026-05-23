# GitHub Labels And Branch Protection Checklist

Apply these settings once in `YuanshuoDu/applymate-jobcopilot`.

## Labels

Create the following labels:

| Group | Label | Suggested Color |
| --- | --- | --- |
| Type | `type:feat` | `0E8A16` |
| Type | `type:bug` | `D73A4A` |
| Type | `type:refactor` | `5319E7` |
| Type | `type:docs` | `1D76DB` |
| Priority | `P0` | `B60205` |
| Priority | `P1` | `D93F0B` |
| Priority | `P2` | `FBCA04` |
| Status | `spec-ready` | `0E8A16` |
| Status | `in-progress` | `1D76DB` |
| Status | `needs-review` | `5319E7` |
| Status | `needs-fix` | `D73A4A` |
| Status | `blocked` | `BFDADC` |
| Status | `done` | `C2E0C6` |
| Assignee | `assignee:codex` | `7057FF` |
| Assignee | `assignee:claude` | `FBCA04` |

## Branch Protection For `main`

Enable:

- Require a pull request before merging
- Require approvals: `1`
- Dismiss stale pull request approvals when new commits are pushed
- Require status checks to pass before merging
- Require branches to be up to date before merging
- Restrict direct pushes to `main`
- Allow squash merge

Recommended required checks:

- `lint`
- `typecheck`
- `test`
- `build`

## Optional Automation

- Auto-add `needs-review` when a PR is opened by Codex.
- Auto-remove `needs-review` and add `needs-fix` when Claude requests changes.
- Auto-add `done` after squash merge closes the linked Issue.

## Manual Rollout Order

1. Create labels.
2. Commit the `.github` templates and docs from this repo change.
3. Make sure CI can actually run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
4. Only then enable required status checks on `main`.
