## Linked Issue
Closes #

## What Changed
<!-- 1 paragraph: what this PR does and why -->

## Layer 1 — Code AC Self-Check
| AC | Status | Evidence |
|----|--------|----------|
| AC1: ... | ✅ / ❌ | file:line |

## Layer 2 — Goal Alignment
| Goal | Status | Notes |
|------|--------|-------|
| Cost / EU coverage / reliability | ✅ / N/A | |

## How to Verify
- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`

## Risks / Follow-ups

## Risk & Rollback
- 

---
**Reviewer Checklist (for @claude)**
- [ ] All ACs satisfied
- [ ] No scope creep (only files in issue Tech Notes)
- [ ] Lockfile: only declared deps
- [ ] Type-safe: no unneeded `as any`
- [ ] Dry-run paths tested if applicable
- [ ] No key-path regression from manual check or E2E evidence
- [ ] Follows repository design system and dev workflow constraints
