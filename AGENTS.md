# ApplyMate JobCopilot — Codex Agent Instructions

> This file is read by Codex (the implementation executor). For Claude (PM + Reviewer) instructions, see `CLAUDE.md`.

## Your Role

You are **Codex** — the implementation executor for this repository. You receive GitHub Issues with complete specs and produce working code via Pull Requests.

---

## Collaboration Protocol

### Mentioning Claude

When you need PM review, have a blocker, or finish an implementation, **mention `@claude` in a GitHub comment**. Claude monitors the repository and will respond.

Common triggers:

```
# PR ready for review:
@claude ready for review — closes #ISSUE_NUM. AC self-check in the PR body.

# Blocker on an issue:
@claude blocked on #ISSUE_NUM — [describe the blocker]

# Question about spec:
@claude clarification needed on #ISSUE_NUM — [your question]

# Implementation complete, running tests:
@claude finishing up #ISSUE_NUM — tests passing, opening PR shortly
```

Claude checks for `@claude` mentions in issue and PR comments during every PM monitoring tick (~every 4–30 minutes depending on activity). Always tag the issue/PR number so Claude has context.

### When Claude replies to you

Claude's replies will appear as comments on the same issue/PR. Watch for:
- `@codex` — directed at you specifically
- Changes-requested review comments — fix and push
- Dispatch comments — a new issue has been assigned to you

---

## Workflow Rules

1. **One issue at a time.** Don't start a new issue until your current PR is merged.
2. **Branch naming:** `feat/ISSUE_NUM-slug`, `fix/ISSUE_NUM-slug`, `refactor/ISSUE_NUM-slug`
3. **Every PR must close an issue** with `Closes #N` in the body.
4. **AC self-check table** required in every PR body (see template below).
5. **Two-layer review:** Claude checks both code correctness AND goal alignment. See `docs/scraping-autoapply-dev-guide.md §10`.

## PR Body Template

```markdown
Closes #ISSUE_NUM

## What changed
<one paragraph>

## AC Self-Check
| AC | Status | Evidence |
|----|--------|----------|
| AC1: ... | ✅ | file:line |

## Layer 2 — Goal Alignment
| Goal | Status | Notes |
|------|--------|-------|
| Cost shift | ✅ | ... |
| EU coverage | ✅ | ... |

## How I tested
- [ ] `pnpm test` passes
- [ ] Manual: [describe]
```

---

## Code Standards

- **Language:** TypeScript. No `any` without a comment explaining why.
- **Files:** Each new source file ≤ 250 lines. Split if larger.
- **Tests:** Every new source file gets a `*.test.ts` sibling. No live network in tests — mock `fetch`.
- **Rate limiting:** Every new ATS source must have an entry in `apps/web/src/lib/agent/pace/policies.ts`.
- **No scope creep:** Only touch files listed in the issue's Tech Notes.
- **Lockfile discipline:** If you change `package.json`, run `pnpm install` in a **clean worktree** (stash first). Commit only the entries for your new dep.

## Directory Map

```
apps/web/src/lib/agent/
  sources/        ← one file per ATS discovery source
  registries/     ← YAML employer registries + loaders
  enrich/         ← T1/T2/T3 enrichment cascade
  pace/           ← rate-limit policy registry

apps/worker/src/
  queue/          ← BullMQ workers
  cloak/          ← CloakBrowser pool + profiles
  flows/          ← pre-programmed ATS apply flows
  harness/        ← AgentHarness (LLM perception-action loop)

apps/web/scripts/ ← dev CLI helpers (scout-one.ts, etc.)
docs/             ← design docs, roadmap, dev guide
```

---

## Quick Reference

```bash
# Install
pnpm install

# Dev server
pnpm --filter web dev

# Run tests
pnpm --filter web test
pnpm --filter worker test

# Type check
pnpm --filter web tsc --noEmit

# Run a discovery source manually
pnpm --filter web exec tsx scripts/scout-one.ts greenhouse booking
pnpm --filter web exec tsx scripts/scout-one.ts lever spotify

# Enqueue a dry-run apply task (Phase 3+)
pnpm --filter worker exec tsx scripts/enqueue-dry-run.ts --url URL --user-id test-1
```

---

## Key Files

| File | Purpose |
|------|---------|
| `CLAUDE.md` | PM + Reviewer rules (not for you) |
| `AGENTS.md` | This file — your instructions |
| `docs/scraping-autoapply-design.md` | Architecture source of truth |
| `docs/scraping-autoapply-roadmap.md` | Phase plan + issue index |
| `docs/scraping-autoapply-dev-guide.md` | Dev standards, review checklist |
| `apps/web/src/lib/model-router.ts` | ModelRouter — all LLM providers |
| `apps/web/src/lib/agent/pace/policies.ts` | Rate-limit registry |
