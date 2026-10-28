# Contributing

Thanks for helping improve ApplyMate.

## Before you start

- Read the [repository overview and local quick start](../README.md#quick-start).
- For agent or application workflow changes, read the [developer guide](../docs/scraping-autoapply-dev-guide.md) and [GitHub collaboration guide](../docs/github-collaboration.md). For Harness V2 changes, also read the [technical design](../docs/agent-harness-v2-technical-design.md).
- For a bug or feature, use the matching [issue form](https://github.com/YuanshuoDu/applymate-jobcopilot/issues/new/choose) and agree on the scope before implementation.

## Pull requests

- Keep the change focused on its issue and use a pull request. Do not push directly to `master`.
- Describe the user-visible change and known limits. Include both review checks: **Layer 1 — Code AC Self-Check**, mapping each acceptance criterion to evidence, and **Layer 2 — Goal Alignment**, explaining how the change serves the issue goal.
- Run the focused checks for the changed area and report the exact commands and results. For documentation-only changes, check the edited links and Markdown rendering; application tests are not needed.
- Distinguish mocked checks from runs against PostgreSQL, Redis, a browser, or an external provider, and state whether each ran locally or in CI. A skipped integration check is not a passed integration.
- Never include credentials, tokens, or real candidate data in commits, fixtures, screenshots, or logs.
