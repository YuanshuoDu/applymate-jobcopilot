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

## Tests
- [ ] `pnpm --filter <app> test` — N/N pass
- [ ] `pnpm --filter <app> tsc --noEmit` — 0 errors

## Risks / Follow-ups

---
**@claude Reviewer Checklist**
- [ ] All ACs satisfied
- [ ] No scope creep (only files in issue Tech Notes)
- [ ] Lockfile: only declared deps
- [ ] Type-safe: no unneeded `as any`
- [ ] Dry-run paths tested if applicable
