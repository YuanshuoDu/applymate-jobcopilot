## Linked Issue
Closes #<!-- replace with the GitHub issue number -->

## Scope
- **Branch:** `codex/ah2-<n>-<slug>` (AH2 issues) or `feat|fix|refactor|chore|docs|test|release/<slug>`
- **Files changed:** <!-- list every file touched by this PR -->
- **In scope?** ✅ / ❌ All changes are within the linked issue's In-scope / Tech Notes. List any deviation here.

## What Changed
<!-- One paragraph: what this PR does and why. Reference the linked issue's Goal. -->

## Layer 1 — Code AC Self-Check
Fill **every** acceptance criterion from the linked issue. Evidence must be a concrete `file:line` from this diff — no hand-waving, no "done".

| AC | Status | Evidence (file:line) |
|----|--------|----------------------|
| AC1: ... | ✅ / ❌ | ... |
| AC2: ... | ✅ / ❌ | ... |

## Layer 2 — Goal Alignment
| Goal | Status | Notes |
|------|--------|-------|
| Cost / EU coverage / reliability / module boundary / scope | ✅ / N/A | ... |

## Verification Evidence (mark what was actually run)
- [ ] **V1** — unit/contract tests: `pnpm --filter <pkg> test` (attach result)
- [ ] **V2** — integration/fault/DB tests: ...
- [ ] **V3** — CI / staging smoke: ...
- [ ] **V4** — browser/manual: ... (screenshot/trace for UI or flow changes)
- [ ] **V5** — production observation: ... (rollout/external-write issues only)
- **CI status:** ✅ green / ❌ failing — <reason>

## Lockfile / Migration / Feature Flags
- **Lockfile:** unchanged / `pnpm install` run in a clean worktree
- **Migration:** none / additive / destructive — rollback explained below if migration
- **Feature flags:** none / `<flag>=<value>` — new V2 flags default **off**

## Risks / Follow-ups
- ...

---
**Reviewer Checklist (for @claude)**
- [ ] Every AC verified directly in the diff (not from self-claims)
- [ ] No scope creep beyond the issue's In-scope
- [ ] Lockfile: no phantom / unsynced dependencies
- [ ] Type-safe, no unneeded `as any`
- [ ] Dry-run / fill-only paths tested where applicable
- [ ] No regression in existing flows (E2E/manual evidence)
- [ ] Follows repository design system & dev workflow constraints
