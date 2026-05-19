# ApplyMate JobCopilot Agent Collaboration

This repository uses a strict GitHub-centered collaboration model:

- GitHub Issue is the single source of truth for feature and bug work.
- Claude acts as PM/Reviewer and should not directly implement business code.
- Codex acts as Executor/Debugger and should not make product-scope decisions.
- Workflow state is driven by labels: `spec-ready`, `in-progress`, `needs-review`, `needs-fix`, `blocked`, `done`.

## Operating Rules

- No Issue, no code.
- Every implementation PR must link and close exactly one primary Issue.
- Scope changes require an Issue comment and Claude approval before implementation continues.
- Communication happens in Issue comments and PR comments with `@codex` / `@claude`.
- Main must stay protected: at least one review plus passing CI.

## Canonical Docs

- Collaboration playbook: `docs/github-collaboration.md`
- GitHub setup checklist: `docs/github-labels-and-protection.md`
- Issue templates: `.github/ISSUE_TEMPLATE/`
- PR template: `.github/pull_request_template.md`

## Role Entry Points

When starting an agent session, use the prompts in `docs/github-collaboration.md`:

- Claude Code: PM / Reviewer prompt
- Codex: Executor / Debugger prompt
