# CI for dependent Agent PRs

When this workflow version is active, its existing checks are eligible for pull requests targeting `master`, `feat/**`, `fix/**`, `refactor/**`, `chore/**`, and `codex/**` branches. This lets a dependent PR be checked against its selected stack base. The branch filter alone does not start or refresh a run: GitHub must evaluate this workflow for an eligible pull-request event.

A green dependent-PR run validates that PR against its current base; it does not validate the combined changes on `master`. After its dependencies reach `master`, retarget the PR to `master` and require a fresh eligible run before treating it as integration-checked. Retargeting alone is not evidence that checks ran.

These checks do not prove live-provider behavior, authenticated browser behavior, staging, or production behavior. Vercel build quota is separate from GitHub Actions CI.
