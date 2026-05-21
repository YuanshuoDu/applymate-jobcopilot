# Scraping & Auto-Apply — Developer Guide

> **Status:** Draft v1 · 2026-05-21
> **Audience:** Codex (executor), Claude (PM/reviewer), any future contributor
> **Related:** [`scraping-autoapply-design.md`](./scraping-autoapply-design.md), [`scraping-autoapply-roadmap.md`](./scraping-autoapply-roadmap.md), [`github-collaboration.md`](./github-collaboration.md), `../CLAUDE.md`

This guide tells you **how to actually work on this initiative**. It is the rules-of-the-road document — branch naming, where to put code, how to test, how to run CloakBrowser locally, what to put in a PR description. If something here contradicts `CLAUDE.md`, `CLAUDE.md` wins.

---

## 1. Quick start (10 min)

```bash
# 1. Pull the docs branch (or master after this PR merges)
git checkout master && git pull --rebase origin master

# 2. Confirm prerequisites
node --version    # ≥ 20
pnpm --version    # ≥ 9
docker --version  # ≥ 24 (for worker dev)
gh --version      # GitHub CLI

# 3. Install deps
pnpm install

# 4. Read these three files in order:
#    docs/scraping-autoapply-design.md
#    docs/scraping-autoapply-roadmap.md
#    docs/scraping-autoapply-dev-guide.md  (this file)

# 5. Look at open issues
gh issue list --repo YuanshuoDu/applymate-jobcopilot --label spec-ready --label "type:feat"
```

---

## 2. Where code lives

| Layer | Path | What goes here |
|---|---|---|
| Discovery sources (HTTP-only) | `apps/web/src/lib/agent/sources/` | One file per ATS: `greenhouse.ts`, `lever.ts`, `workday.ts`, ... Pure async function returning `DiscoveredJob[]`. No browser code. |
| Enrichment cascade | `apps/web/src/lib/agent/enrich/` | `jsonld.ts` (T1), `ats-selectors.ts` (T2), `llm.ts` (T3), `index.ts` (orchestrator). |
| Employer registries | `apps/web/src/lib/agent/registries/` | YAML or JSON files per ATS: `greenhouse.yaml`, `lever.yaml`, `workday.yaml`. Source of truth. |
| Apply flows (server-side) | `apps/worker/src/flows/` | One file per ATS: `workday.ts`, `greenhouse.ts`, ... Each exports `{matches, apply}` from a common `AtsFlow` interface. |
| Worker infra | `apps/worker/src/{queue,cloak,storage}/` | BullMQ workers, CloakBrowser pool, storage-state persistence. |
| Fixtures (tests) | `apps/worker/fixtures/{ats}/` | Recorded HTML/HAR per ATS for replay tests. |
| Shared types | `packages/shared/src/types.ts` | `DiscoveredJob`, `EnrichedJob`, `ApplyTask`, `ApplyResult`. |

If you're adding a new ATS, you touch **at most**:

1. `sources/{ats}.ts` (discovery)
2. `registries/{ats}.yaml` (employers)
3. `flows/{ats}.ts` (apply)
4. `fixtures/{ats}/` (recorded HTML)

Don't sprinkle ATS-specific code into shared modules. If a piece of logic feels generic, ask whether it's actually shared by 3+ ATSes before promoting it.

---

## 3. Branch and PR conventions

### Branch naming

```
feat/<issue-id>-<slug>          # new ATS source, new flow, new infra
fix/<issue-id>-<slug>           # bug fix on existing code
refactor/<issue-id>-<slug>      # internal restructure, no behavior change
docs/<slug>                     # docs-only PRs (no issue required)
chore/<issue-id>-<slug>         # build, CI, deps
```

### Commit messages (Conventional Commits, scoped)

```
feat(scout/greenhouse): add public boards API source
fix(worker/workday): handle CXS API 429 with exponential backoff
refactor(enrich): extract JSON-LD parser into its own module
docs(scraping-autoapply): clarify rate-limit policy
chore(deps): add cloakbrowser to apps/worker
```

Scope is mandatory. Use `/` to separate area + sub-area when it helps.

### PR title

Mirror the dominant commit type and scope. Single-line. ≤ 72 chars.

```
feat(scout/greenhouse): add public boards API source
```

### PR description (template)

```markdown
Closes #ISSUE_ID

## What changed
<one paragraph, plain English>

## AC self-check
| AC | Status | Evidence |
|----|--------|----------|
| AC1: ... | ✅ | `apps/web/src/lib/agent/sources/greenhouse.ts:42-67` |
| AC2: ... | ✅ | unit test `greenhouse.test.ts:12-30` |

## How I tested
- [ ] `pnpm test` passes
- [ ] Manual: ran `pnpm scout:greenhouse:dev` against staging registry, got N jobs
- [ ] CloakBrowser smoke (if applicable)

## Risks / follow-ups
<if any>
```

The AC table is **mandatory**. Without it, Claude will ask for it before reviewing.

---

## 4. Issue specification standard

Every `spec-ready` issue must satisfy the template in `CLAUDE.md`. For this initiative there are two extra requirements:

1. **Reference the design doc.** First line of the issue body links to the relevant section of `scraping-autoapply-design.md`.
2. **State the cascade tier** (for enrichment) or **the flow class** (for apply). E.g. "This is a Tier-1 (JSON-LD) feature" or "This is a Workday pre-programmed flow."

This makes ad-hoc planning impossible and forces every change back to the design.

---

## 5. Local development workflows

### 5.1 Run a discovery source against a single employer

```bash
pnpm --filter web exec tsx scripts/scout-one.ts greenhouse booking
# → prints N jobs, doesn't write to DB
```

The `scout-one.ts` helper (created in Phase 1.6) takes `<ats> <slug>` and runs the source in isolation. Use this when developing or debugging a source — no DB churn, fast feedback.

### 5.2 Run the enrichment cascade against a single URL

```bash
pnpm --filter web exec tsx scripts/enrich-one.ts https://boards.greenhouse.io/booking/jobs/12345
# → prints which tier hit, full extracted description
```

### 5.3 Run the worker locally

```bash
# In one terminal: Redis
docker run -p 6379:6379 redis:7

# In another: the worker (with hot reload)
pnpm --filter worker dev

# In a third: enqueue a dry-run apply task
pnpm --filter worker exec tsx scripts/enqueue-apply.ts \
  --job-id JOB_ID --user-id USER_ID --dry-run
```

The worker logs the full flow to stdout; screenshots dump to `apps/worker/.tmp/<task-id>/`.

### 5.4 Run a CloakBrowser smoke test

```bash
# One-off, doesn't require the worker harness
pnpm --filter worker exec tsx scripts/cloak-smoke.ts \
  --url https://www.stepstone.de/jobs/software-engineer/in-berlin
# → prints title, screenshot path, reCAPTCHA score (if any), Turnstile result
```

The PoC for Phase 2.6 lives here. Run it before opening the Phase 3 issues — if CloakBrowser fails on any blocker site, the whole stack changes.

---

## 6. Testing standards

### 6.1 Unit tests (required for every Phase 1+ PR)

- Discovery sources: mock `fetch`, assert mapped `DiscoveredJob` shape.
- Enrichment tiers: feed in known HTML fixture, assert extracted `EnrichedJob`.
- Apply flows: load recorded HTML from `fixtures/<ats>/`, drive the flow in a headless CloakBrowser context, assert `ApplyResult.status === 'submitted'`.
- Worker queue: enqueue, run, assert side effects (DB rows, file artifacts).

Tests live next to source: `foo.ts` + `foo.test.ts`. Use `vitest` (already in repo).

### 6.2 Fixture capture

To record a fixture for a new ATS:

```bash
pnpm --filter worker exec tsx scripts/capture-fixture.ts \
  --url <apply-url> --ats workday --name siemens-de-engineer
# → writes apps/worker/fixtures/workday/siemens-de-engineer/{page.html,screenshots/...}
```

Strip any candidate PII before committing the fixture. The script does a best-effort scrub but you must visually verify.

### 6.3 No live ATS calls in CI

CI is fixture-only. Live tests are gated behind `RUN_LIVE_TESTS=1` and only ever run from a branch you push manually — never on PRs or master.

---

## 7. CloakBrowser usage

### 7.1 Drop-in import

```typescript
// apps/worker/src/cloak/launch.ts
import { launch } from 'cloakbrowser'

export async function launchCloak(opts: { proxy?: string; profileDir?: string } = {}) {
  return launch({
    humanize: true,           // mouse curves + typing rhythm + scroll
    geoip: opts.proxy ? true : false,  // sync timezone/locale to proxy IP
    proxy: opts.proxy,
    userDataDir: opts.profileDir,
    headless: process.env.CLOAK_HEADED ? false : true,
  })
}
```

### 7.2 Per-user profile lifecycle

```typescript
import { getUserProfileDir } from './storage'
import { launchCloak } from './cloak/launch'

export async function withUserBrowser<T>(
  userId: string,
  fn: (browser: Browser) => Promise<T>,
): Promise<T> {
  const profileDir = await getUserProfileDir(userId)  // creates if missing, decrypts on disk
  const browser = await launchCloak({ profileDir, proxy: pickProxy(userId) })
  try {
    return await fn(browser)
  } finally {
    await browser.close()  // CloakBrowser persists profile dir on close
  }
}
```

### 7.3 Rules

- **Never** disable `humanize` in production code paths. If it slows a test, gate it behind an env var.
- **Always** close the browser in a `finally` block. Leaked contexts eat memory fast.
- **Never** launch more than 3 concurrent contexts per worker process without a benchmark. Phase 7.4 dashboard tracks concurrency.
- **Treat profile dirs as PII.** They contain login cookies. Encrypt at rest, never log paths, scrub on user delete.

---

## 8. Rate limiting & politeness

Every outbound source call goes through a shared limiter:

```typescript
import { pace } from '@/lib/agent/pace'

await pace.acquire({ ats: 'workday', host: 'siemens.wd3.myworkdayjobs.com' })
const data = await workdaySearch(...)
```

The `pace` module enforces the limits from §8 of the design doc. Adding a new ATS source **requires** registering its limits in `apps/web/src/lib/agent/pace/policies.ts`. CI blocks PRs that add a source without a policy entry.

If you need to deviate from a published limit (e.g. an ATS document says 10 RPS allowed), put the justification in the PR description AND update the design doc § 8.

---

## 9. CAPTCHA & failure handling

### Outcome ladder

```
Try pre-programmed flow      ─► fails ─► escalate
       │
       ▼ success
   submitted

Try pattern cache replay      ─► fails ─► escalate
       │
       ▼ success
   submitted (mark cache hit)

Try AI fallback (Computer Use) ─► fails ─► escalate
       │
       ▼ success
   submitted (write new cache entry)

Escalate:
   CAPTCHA?  ─► CapSolver (if key) ─► retry once
                       │ fails
                       ▼
                  status = 'manual', notify user, save resume state
   Login required?  ─► status = 'needs_user_action', notify user
   Other?           ─► status = 'failed', error logged, NO auto-retry
```

**Never auto-retry a failed submission silently.** Either user-visible or queued for human review. The form-pattern cache invalidates after 3 consecutive failures regardless.

---

## 10. PR review process (what Claude checks)

Every PR goes through **two review layers** in order. A failure on either layer triggers `needs-fix`.

### Layer 1 — Code correctness (inherited from `CLAUDE.md`)

The 7-item mandatory checklist from `CLAUDE.md` applies to every PR. Key items:

| Check | What it means |
|---|---|
| No lockfile phantom entries | `pnpm-lock.yaml` only has entries for declared `package.json` deps |
| No `window.location.href` for in-app nav | Use Next.js router |
| No `outline: none` without `:focus-visible` | EU EAA compliance |
| No module-level `let`/`var` for async guard | Use `useRef` |
| No scope creep | Only files listed in issue Tech Notes |
| No hardcoded literals | No magic numbers/strings replacing dynamic data |
| No dep added without lockfile update | `pnpm install` in clean worktree |

Plus, for this initiative specifically:

| Check | What it means |
|---|---|
| **Cascade tier declared** | Enrichment PRs state which tier they implement; design doc updated if a new tier added. |
| **No live network in tests** | `vi.fn().mockResolvedValue(...)` for `fetch`; no real HTTP unless gated by env var. |
| **Fixture present** | Any apply flow PR includes at least one fixture under `apps/worker/fixtures/<ats>/`. |
| **Rate-limit policy registered** | New source has an entry in `pace/policies.ts`. |
| **PII scrubbed from fixtures** | Reviewer spot-checks for emails, phone numbers, real names. |
| **Storage state never logged** | grep diff for `console.log(.*storageState\|cookies\|profileDir)`. |
| **Design doc unchanged or updated** | If implementation diverged from design, the design doc was updated in the same PR. |

---

### Layer 2 — Goal alignment (new — required on every PR)

Code passing Layer 1 is necessary but not sufficient. Every PR must also advance the initiative's stated goals from [§11 of the design doc](./scraping-autoapply-design.md#11-success-criteria). The reviewer checks this explicitly and includes a **Goal Alignment** section in every review comment.

#### 2A — Discovery source PRs (Phase 1.1–1.3, Phase 2.x, Phase 6.x)

| Goal check | Question to answer |
|---|---|
| **Cost shift** | Does this source produce jobs without a paid API call? If yes, estimate what % of daily jobs could shift to free after this lands. |
| **EU coverage** | How many EU employer records does this add? Does it cover any country/sector not previously covered? |
| **Description completeness** | Do returned `DiscoveredJob` records include `description` ≥ 200 chars from the source directly? If yes, these skip the entire enrichment cascade (T1+T2+T3) — confirm this is wired correctly. |
| **Apply URL quality** | Is `url` a direct ATS apply link (not a job board redirect)? Direct links are required for Mode C (unattended apply). |
| **Source field set** | Is `source` set to a stable identifier (e.g. `'greenhouse'`, `'lever'`, `'workday'`)? Required for per-source dashboards in Phase 7. |
| **Module boundary** | Does the source live in `sources/{ats}.ts` with no imports from `apps/worker`? Discovery and apply are separate layers. |
| **Pace policy present** | Confirmed entry in `pace/policies.ts` — otherwise this source has no ceiling and can get us rate-banned. |

#### 2B — Enrichment PRs (Phase 1.4–1.6)

| Goal check | Question to answer |
|---|---|
| **Token savings** | Estimate what % of jobs this tier will handle without an LLM call. Target: T1+T2 combined ≥ 70%. |
| **Tier cascade correct** | Does the orchestrator skip lower-priority tiers when a higher one succeeds? No double-calling. |
| **Min-length guard** | Does the tier reject descriptions shorter than 200 chars (preventing low-quality short snippets from blocking T2/T3)? |
| **No regression** | Does wiring the cascade into the existing enrich endpoint break anything visible in the current UI? |

#### 2C — Auto-apply PRs (Phase 3.x–5.x)

| Goal check | Question to answer |
|---|---|
| **Mode C path** | Does this build toward fully unattended application submission (user offline, server submits)? |
| **ATS flow coverage** | Which ATS does this cover? Expected submit success rate vs. the 80% target in §11. |
| **CloakBrowser used** | Is the browser session going through CloakBrowser (not stock Playwright)? Required for EU anti-bot sites. |
| **humanize enabled** | Is `humanize: true` set in the CloakBrowser launch config? Required in production paths. |
| **Pattern cache wired** | On successful submission, is the field mapping written to `form_patterns` table? |
| **Per-user isolation** | Does each user get a separate CloakBrowser profile dir? No cross-user session contamination. |
| **Rate limits enforced** | Is the per-user (30/hr) and per-domain (5/hr) ceiling applied before this worker starts? |

#### 2D — All PRs: integration checkpoint

Answer these for every PR regardless of type:

1. **Pipeline position**: where does this fit in the 6-stage pipeline (discover → enrich → score → tailor → cover → apply)? Does it integrate correctly at that stage?
2. **Blocking risk**: does this PR introduce a dependency that could stall a later phase? (e.g. a type change that breaks `discover.ts` before the aggregator is updated)
3. **Observable progress**: after this merges, will the [§11 success criteria](./scraping-autoapply-design.md#11-success-criteria) measurably improve? If no, is it pure infrastructure that unblocks a later PR?

---

### Review comment format

Every review comment must include both layers:

```markdown
## [APPROVED / CHANGES REQUESTED]

### Layer 1 — Code correctness
| Check | Status | Evidence |
|---|---|---|
| AC1: ... | ✅ / ❌ | file:line |
...

### Layer 2 — Goal alignment
| Goal | Status | Notes |
|---|---|---|
| Cost shift | ✅ | Adds N Greenhouse employers → ~X% of daily jobs shift to free |
| EU coverage | ✅ | Covers DE/NL/IE sectors previously missing |
| Description completeness | ✅ | `content` field returned inline — no enrichment needed |
| Apply URL quality | ✅ | `absolute_url` is direct Greenhouse apply link |
| Source field set | ✅ | `source: 'greenhouse'` |
| Module boundary | ✅ | No worker imports |
| Pace policy present | ✅ | `policies.ts` line 17 |

### Integration checkpoint
- Pipeline position: Discovery stage (Stage 1)
- Blocking risk: None — additive only, no existing code changed
- Observable progress: After merge, scout pipeline has 2 free ATS sources. With Phase 1.3 registry, est. 60+ EU employers covered.
```

A PR that fails any Layer 1 OR Layer 2 check gets `needs-fix` with a specific comment per failure. We do not pile up review rounds — one comment, one fix, one re-review, merge.

---

## 11. How to file the next issue

When you (Codex or a contributor) finish a Phase N issue and want to suggest a follow-up:

1. **Do not open the next issue yourself.** Comment on the closed issue with the suggestion.
2. **Include:** problem statement (1 paragraph), proposed AC list, design-doc reference, rough effort estimate.
3. Claude (PM) decides whether it becomes a `spec-ready` issue, gets deferred, or is rejected.

This keeps the PM loop intact and prevents drift.

---

## 12. Common pitfalls (learned the hard way)

1. **Don't trust JSON-LD blindly.** Some sites embed multiple `JobPosting` objects per page (one per related job). Filter by `@id` matching the current URL or pick the first object with the longest description.
2. **Workday CXS is region-sharded.** A tenant might respond on `wd3.myworkdayjobs.com` but not `wd5`. Store the verified base URL per employer, don't guess.
3. **`humanize=True` mutates timing.** A flow that completes in 8s with stock Playwright might take 25s with CloakBrowser. Adjust timeouts and progress UI accordingly.
4. **Storage state grows.** After a few months of cookies, profile dirs can exceed 100 MB. Add a cleanup job (Phase 7) to prune session storage for sites the user hasn't visited in 90 days.
5. **Greenhouse `content` field is HTML.** Strip with `cheerio` or the existing `stripHtml` helper before storing as `full_description`.
6. **Lever pagination is forward-only.** No `offset`; you must follow `nextUrl` links. Stop conditions on empty result.
7. **ATS detector false positives.** A page can match Workday selectors but not be a Workday apply page (e.g. a job board that embeds a Workday widget). Always check the URL hostname AS WELL AS the DOM.

If you discover a new pitfall, add it here in your PR.

---

## 13. Glossary

- **ATS** — Applicant Tracking System (Workday, Greenhouse, Lever, etc.).
- **Cascade tier** — One of T1 (JSON-LD), T2 (CSS selectors), T3 (LLM extraction). Order = increasing cost.
- **Flow** — A pre-programmed sequence of browser actions to submit an application on a specific ATS.
- **Pattern cache** — Persisted field mapping from successful AI-fallback runs, replayed on subsequent same-company submissions.
- **Mode A/B/C** — Assisted (user clicks) / Semi-auto (extension submits) / Unattended (server worker). See design doc §6.
- **Persona** — The user's profile data: contact info, work auth, preferences, EEO defaults. Used to fill forms.
- **Storage state** — Persisted browser cookies + localStorage per user. Required for sites where the user has prior session.

---

## 14. References

- Design doc: [`scraping-autoapply-design.md`](./scraping-autoapply-design.md)
- Roadmap: [`scraping-autoapply-roadmap.md`](./scraping-autoapply-roadmap.md)
- Repo PM rules: [`../CLAUDE.md`](../CLAUDE.md)
- Collaboration playbook: [`github-collaboration.md`](./github-collaboration.md)
- ApplyPilot (architectural inspiration): https://github.com/Pickle-Pixel/ApplyPilot
- CloakBrowser: https://github.com/CloakHQ/CloakBrowser
- Greenhouse API docs: https://developers.greenhouse.io/job-board.html
- Lever API docs: https://github.com/lever/postings-api
