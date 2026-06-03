# ApplyMate JobCopilot — Codex Agent Instructions

> **Read this file completely before touching any code.**
> This file is for Codex (the implementation executor). For Claude (PM + Reviewer) instructions, see `CLAUDE.md`.

---

## Part 1 — What Is ApplyMate?

### Product in One Sentence

ApplyMate is a SaaS job application copilot for the **European job market** that helps candidates go from "I want a job" to "I have an offer" — with AI handling as much of the process as possible.

### The Problem We Solve

Job searching in Europe is painful:
- Dozens of job boards with different interfaces (LinkedIn, Indeed, StepStone, Xing, EURES, company career pages)
- Every ATS (Workday, Greenhouse, Lever, SmartRecruiters) has a different form structure
- Candidates manually rewrite their resume for each job — takes hours
- Cover letters are generic and slow to write
- Applications go into a black hole — no tracking

ApplyMate automates all of this.

### Core User Journey

```
1. User uploads resume → AI parses it into structured Persona data
2. User sets target: "Software Engineer in Berlin / Amsterdam, €70-90k"
3. AI Agent discovers matching jobs (50+ sources, updated daily)
4. AI scores each job 1-10 based on resume match + extracts ATS keywords
5. User reviews shortlist → approves which ones to apply to
6. AI tailors resume keywords per job, writes cover letter
7. AUTO-APPLY: Agent fills forms, uploads docs, submits — 24/7 without user
8. Gmail integration tracks replies: interviews, rejections, follow-ups
9. Dashboard shows full application funnel
```

**Today (shipped):** Steps 1-6 work. The Chrome Extension assists with step 7 (user must be present).

**What we're building now:** Step 7 fully autonomous (no user needed), and making step 3 much better (more sources, zero cost).

### Target Users

- Software engineers, data scientists, product managers seeking EU tech jobs
- Primarily non-native EU speakers applying across borders (e.g., Ukrainian in Germany, Indian in Netherlands)
- Also EU nationals applying across countries (French engineer in Ireland)

### Business Model

- **Free plan**: limited AI credits, manual apply
- **Pro plan**: unlimited discovery, auto-apply, full AI features
- Platform provides MiniMax M2.7 API as the default AI (our cost)
- Users can bring their own API keys (Claude, GPT-4o, etc.) in Settings → AI Models

---

## Part 2 — Architecture Overview

### Monorepo Structure

```
applymate-jobcopilot/
├── apps/
│   ├── web/          ← Next.js 14 app (main product, deployed on Vercel)
│   ├── extension/    ← Chrome Extension (Plasmo framework, MV3)
│   └── worker/       ← Server-side apply worker (Node.js, being built now)
├── packages/
│   ├── shared/       ← Shared types + utilities
│   └── ui/           ← Shared UI components
├── docs/
│   ├── scraping-autoapply-design.md   ← Architecture source of truth
│   ├── scraping-autoapply-roadmap.md  ← Phase plan + all issue numbers
│   └── scraping-autoapply-dev-guide.md ← Your coding standards
└── AGENTS.md         ← This file
```

### Key Technologies

| Layer | Technology | Why |
|-------|-----------|-----|
| Frontend | Next.js 14 App Router | EU deployment, SSR for SEO |
| Database | Prisma + PostgreSQL (Neon) | User data, jobs, applications |
| AI | ModelRouter (custom) | Any LLM: Claude, GPT, MiniMax, DeepSeek, local |
| Extension | Plasmo (Chrome MV3) | Form scanning + assisted fill |
| Worker | Node.js + BullMQ | Async job queue for auto-apply |
| Browser | CloakBrowser (stealth Playwright) | Bypasses bot detection |
| Cache | Redis (Upstash) | BullMQ queue + rate limiting |
| Deploy | Vercel (web) + Fly.io (worker) | |

### AI Model Strategy

```
ModelRouter resolves: user setting → platform default → nothing
Platform default: MiniMax M2.7 (our MINIMAX_API_KEY, ~$0.001 per task)
Per-feature config in Settings:
  - scoring/jobScoring: job match scoring (1-10) + keyword extraction
  - autoApply: autonomous form-filling agent
  - formFill: Extension-assisted fill (existing)
  - coverLetter, suggest, parsing: other AI features
```

See `apps/web/src/lib/model-router.ts` — do NOT add new providers without discussing with PM.

### How Forms Are Filled (Two Modes)

**Mode A — Assisted (existing, Extension):**
User opens a job application page → clicks ApplyMate button in Chrome sidebar → Extension scans the DOM → calls our API with field list → LLM suggests values from Persona → Extension injects values → user reviews + submits.

**Mode C — Unattended (being built):**
User queues a job to auto-apply → goes offline → BullMQ task picked up by Worker server → CloakBrowser navigates to the apply URL → AgentHarness perception-action loop fills the form → submits → writes result to DB → notifies user.

---

## Part 3 — Current Initiative: Scraping & Auto-Apply

We are building two things in parallel:

### Initiative A: Free ATS Discovery (reduce API costs)

**The problem:** Today we pay for 11+ RapidAPI subscriptions to discover EU jobs. Cost grows linearly with users. We want to switch to free, direct ATS APIs that return the same (or better) data.

**The solution:** 4 major ATS platforms expose free undocumented (but stable) JSON APIs:

| ATS | How to call | What we get | EU employers |
|-----|-------------|-------------|--------------|
| Greenhouse | `GET boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` | Full JD inline, direct apply URL | Booking.com, N26, GitLab, HelloFresh |
| Lever | `GET api.lever.co/v0/postings/{slug}?mode=json` | Full JD, hostedUrl | Spotify, Klarna, Tier Mobility |
| Workday CXS | `POST {tenant}.wd3.myworkdayjobs.com/wday/cxs/...` | Full JD, paginated | SAP, Siemens, VW, Adidas, Allianz |
| SmartRecruiters | `GET api.smartrecruiters.com/v1/companies/{company}/postings` | Full JD | Bayer, Puma |

When these sources return full JDs, we skip the entire enrichment LLM call (saving money). The `full_description` field in the job DB row goes from null → populated without any LLM cost.

**Progress:** Greenhouse (#16 ✅ done), Lever (#17 🔄 in progress).

### Initiative B: Server-Side Auto-Apply (Mode C)

**The problem:** ApplyPilot (open source, 1k stars) proves autonomous job application is possible. We need our own version. Today, our Extension requires the user to be present.

**The solution stack:**
```
CloakBrowser (stealth headless Chrome)
    + AgentHarness (LLM perception-action loop, like Claude Code)
    + ModelRouter (MiniMax M2.7 by default)
    + Pre-programmed ATS flows (for Workday/Greenhouse/Lever specifically)
    → Fully autonomous form fill + submit
```

**CloakBrowser** (17.9k GitHub stars, MIT) is a source-patched Chromium that passes all bot detection: reCAPTCHA v3 score 0.9, Cloudflare Turnstile auto-pass. Drop-in Playwright replacement.

**AgentHarness** is what we're building to replace Claude Code CLI. It's a while loop:
```
perceive DOM state → call LLM (returns next action) → execute via Playwright → repeat until submitted
```

**Key insight from ApplyPilot:** Pre-programmed flows for known ATSes (Workday has a fixed 5-step wizard, Greenhouse has a standard form) cover 80% of applications. The LLM agent is the fallback for unknown forms.

**Status:** CloakBrowser PoC (#31) to run first as a GO/NO-GO gate.

---

## Part 4 — Your Role (Codex)

You receive GitHub Issues with complete specs. Your job:

1. **Read the issue fully** — including Problem, Goal, Tech Notes, and the design docs linked in the issue.
2. **Read the design doc** — `docs/scraping-autoapply-design.md` is the source of truth. Understand where your issue fits in the pipeline.
3. **Implement exactly what's specified** — no scope creep, no "improvements" to adjacent code.
4. **Open a PR** — with the two-layer AC self-check table (see Part 5).
5. **Mention @claude** — when ready for review or if blocked.

---

## Part 5 — Workflow Rules

### One issue at a time
Don't start a new issue until your current PR is merged.

### Branch naming
```
feat/ISSUE_NUM-short-slug     ← new functionality
fix/ISSUE_NUM-short-slug      ← bug fix
refactor/ISSUE_NUM-short-slug ← restructure without behavior change
chore/ISSUE_NUM-short-slug    ← build, deps, CI
```

### @claude Protocol

When you need PM response, mention `@claude` in a GitHub issue or PR comment:

```
# PR ready:
@claude ready for review — closes #17. AC self-check in the PR body.

# Blocker:
@claude blocked on #17 — Lever API returns 403 for some slugs, not sure if IP blocked or slug wrong.

# Clarification:
@claude clarification on #18 — the spec says ≥30 entries per registry, but should I include companies that have no open jobs right now?

# Finishing soon:
@claude finishing up #17 — tests passing, opening PR in ~5 min.
```

Claude checks for `@claude` mentions at the start of every PM monitoring tick (every 4–30 min depending on activity). Always include the issue number.

### PR Body (Required Format)

```markdown
Closes #ISSUE_NUM

## What changed
<1 paragraph explaining what this PR does and why>

## Layer 1 — Code AC Self-Check
| AC | Status | Evidence |
|----|--------|----------|
| AC1: [exact text from issue] | ✅ | `path/to/file.ts:line` |
| AC2: ... | ✅ | ... |

## Layer 2 — Goal Alignment
| Goal check | Status | Notes |
|------------|--------|-------|
| Cost shift (% jobs moving to free APIs) | ✅ | [estimate] |
| EU coverage (new employers/countries) | ✅ | [list] |
| Description completeness (skips enrichment?) | ✅ | [yes/no + why] |
| Apply URL quality (direct ATS link?) | ✅ | [yes/no] |
| Source field set correctly | ✅ | `source: 'lever'` |
| Pace policy registered | ✅ | `policies.ts:line` |
| Module boundary respected | ✅ | No worker imports |

## How I tested
- [ ] `pnpm --filter web test -- path/to/test.ts` — N/N tests pass
- [ ] Manual: `pnpm --filter web exec tsx scripts/scout-one.ts lever spotify` → N jobs printed
- [ ] `pnpm --filter web tsc --noEmit` — no new type errors

## Risks / Follow-ups
<if any>
```

The Layer 2 section is **required**. Without it, Claude will request changes.

---

## Part 6 — Code Standards

### File size
- Source files: ≤ 250 lines. If larger, split into focused modules.
- Test files: no limit, but keep each `describe` block focused.

### TypeScript
- No `any` without an inline comment explaining why.
- Prefer `unknown` + type narrowing over `any`.
- Export only what callers need — keep internals unexported.

### Tests
- Every new `*.ts` source file gets a `*.test.ts` sibling.
- **No live network calls in tests** — mock `fetch` with `vi.spyOn`.
- Use `vitest` (already configured in `apps/web`).
- Test files live next to source: `greenhouse.ts` + `greenhouse.test.ts`.

### Rate limiting
Every new ATS discovery source **must** have an entry in `apps/web/src/lib/agent/pace/policies.ts` before the PR is opened. No exceptions. The CI will eventually reject PRs without it.

### Lockfile discipline
If you change `package.json`, you MUST:
1. Stash all other changes first
2. Run `pnpm install` in a clean worktree
3. Commit ONLY the lockfile entries for your new dependency
4. Pop stash and continue

No phantom entries. Reviewers check the lockfile diff.

### Scope
Only touch files listed in the issue's Tech Notes section. If you discover related code that needs improvement, mention it in the PR description under "Risks / Follow-ups" — don't fix it.

---

## Part 7 — Directory Map

```
apps/web/src/
  lib/
    model-router.ts          ← LLM abstraction (ModelRouter), FeatureIds
    agent/
      discover.ts            ← DiscoveredJob type, orchestration entry
      sources/               ← ONE FILE PER ATS: greenhouse.ts, lever.ts, ...
      registries/            ← YAML employer lists + TS loaders
      enrich/                ← T1/T2/T3 enrichment cascade
      pace/
        policies.ts          ← Rate-limit registry (REQUIRED for all sources)
    form-fill-prompts.ts     ← LLM prompts for assisted form fill (Extension)
    db.ts                    ← Prisma client
  app/api/
    jobs/[id]/               ← Job scoring, apply, enrich endpoints

apps/extension/src/
  content/form-injector.ts   ← Injects form-fill UI into pages
  lib/form-filler/
    form-scanner.ts          ← Scans DOM for form fields (657 lines)
    auto-fill.ts             ← Fills fields via DOM manipulation

apps/worker/src/             ← Being built in Phase 3
  queue/                     ← BullMQ workers
  cloak/                     ← CloakBrowser pool + per-user profiles
  flows/                     ← Pre-programmed ATS form flows
  harness/                   ← AgentHarness (LLM perception-action loop)

apps/web/scripts/
  scout-one.ts               ← Dev CLI: test a single ATS source manually

docs/
  scraping-autoapply-design.md   ← Architecture (read this!)
  scraping-autoapply-roadmap.md  ← Phase plan
  scraping-autoapply-dev-guide.md ← Dev standards + two-layer review spec
  superpowers/specs/         ← Design specs
```

---

## Part 8 — Quick Reference

```bash
# Setup
pnpm install

# Dev server (web)
pnpm --filter web dev          # → localhost:3000

# Run tests
pnpm --filter web test         # all tests
pnpm --filter web test -- src/lib/agent/sources/lever.test.ts  # one file

# Type check
pnpm --filter web tsc --noEmit --skipLibCheck

# Test a discovery source manually
pnpm --filter web exec tsx apps/web/scripts/scout-one.ts greenhouse booking
pnpm --filter web exec tsx apps/web/scripts/scout-one.ts lever spotify
pnpm --filter web exec tsx apps/web/scripts/scout-one.ts workday sap

# Check rate-limit registry
cat apps/web/src/lib/agent/pace/policies.ts

# View open issues
gh issue list --repo YuanshuoDu/applymate-jobcopilot --state open --label in-progress
gh issue list --repo YuanshuoDu/applymate-jobcopilot --state open --label spec-ready
```

---

## Part 9 — Key Business Context for Every Task

When implementing any feature, ask yourself:

1. **Does this reduce cost?** Every Greenhouse/Lever/Workday job fetched for free = one less RapidAPI call. Over 1000 users, this compounds fast.

2. **Does this improve EU coverage?** We care about: DE (Germany), AT, CH (DACH), IE, GB, NL, FR, BE, SE, DK, NO, FI, PL. Country coverage matters more than raw job count.

3. **Does this move us toward autonomous apply?** Even discovery + enrichment improvements unblock the apply pipeline — if we have full JDs, the agent can score, tailor, and apply without extra API calls.

4. **Does this improve data quality?** The LLM scoring prompt uses `full_description`. Short or missing descriptions → bad scores → wrong jobs auto-applied. Quality data = better product.

5. **Is it compliant?** We respect robots.txt. We rate-limit aggressively. We don't scrape sites that block us (Glassdoor, Google Jobs). We don't auto-apply to LinkedIn (ToS). When in doubt, ask `@claude`.

---

## Part 10 — Current Issue Queue (as of 2026-06-03)

**Phase 1-2 ✅ 完成** — Greenhouse, Lever, Workday CXS, SmartRecruiters, Personio, Multi-source Dedup, registries, enrichment cascade.

**Phase 3 ✅ 完成** — Worker skeleton, CloakBrowser pool, AgentHarness.

**Phase 4 🔄 进行中:**
- Workday apply flow ✅, Greenhouse apply flow ✅, Lever apply flow ✅
- **#162** — SmartRecruiters apply flow ✅ done (PR #165)
- **#163** — ATS detector ✅ done (PR #166)
- **#168** — Personio apply flow ✅ done (PR #170)
- **#169** — Shared flow helpers ✅ done (PR #172)
- **#171** — verify-flow Personio support ✅ done (PR #173)

**Phase 5 — Form-Pattern Cache 护城河:**
- **#174** — FormPattern model + CRUD 🔄 in-progress (just dispatched)
- **#175** — Pattern replay engine ⏳ spec-ready
- **#176** — Confidence decay ⏳ spec-ready
- **#177** — AI budget cap ⏳ spec-ready
- **#178** — Phase 5 integration wiring ⏳ spec-ready (P0, depends on #174-177)

**Phase 5 护城河 (待创建):**
- Form-pattern cache, Pattern replay, Confidence decay, Budget cap

**Later:**
- Personio apply flow, SmartRecruiters/Personio add to ATS detector
- Phase 6: Direct HTML scraping, Phase 7: Production hardening
