# Scraping & Auto-Apply — Architecture Design

> **Status:** Draft v1 · 2026-05-21
> **Owner:** Claude (PM) · **Repo:** YuanshuoDu/applymate-jobcopilot
> **Related:** `scraping-autoapply-roadmap.md`, `scraping-autoapply-dev-guide.md`

This document captures the **target architecture** for ApplyMate's two highest-leverage capabilities: **job discovery** and **autonomous application submission**. It is the single source of truth that all phase-level Issues link back to.

---

## 1. Problem Statement

Two pain points dominate the product economics:

1. **Job discovery is API-bound.** Today every new job comes from a paid third-party API (Adzuna, LinkedIn RapidAPI, Reed, etc.). Cost scales linearly with user count; data freshness is bounded by upstream's polling cadence; and EU-specific coverage is uneven.
2. **Auto-apply requires a human in the loop.** The current form-filler is a Chrome extension that fires only when the user opens the page. There is no "set and forget" mode, and no way to absorb the long tail of ATS-specific quirks without per-site engineering.

The competitor study (`ApplyPilot` open-source repo, 1k+ stars) confirmed the technical primitives that work: **direct ATS JSON APIs**, **3-tier enrichment cascade**, and a **headless browser agent** that submits applications without supervision.

A subsequent discovery — [`CloakBrowser`](https://github.com/CloakHQ/CloakBrowser) (17.9k stars, MIT) — fills the remaining gap: a source-patched Chromium binary that passes every bot-detection test we have to clear (Cloudflare Turnstile, FingerprintJS, reCAPTCHA v3 ≥ 0.9). It is a drop-in Playwright replacement, so adopting it costs one import line.

This document is the plan to build on those primitives.

---

## 2. Goals & Non-Goals

### Goals (in scope for this initiative)

- **Cut RapidAPI spend ≥ 70%** by routing the bulk of discovery through free ATS APIs and direct scraping.
- **Reach 200+ EU employer coverage** via Workday / Greenhouse / Lever / SmartRecruiters / Personio registries.
- **Ship a server-side worker** that can submit applications without the user's browser being open.
- **Achieve ≥ 80% auto-submission success on standardized ATS** (Workday, Greenhouse, Lever) via pre-programmed flows.
- **Survive Cloudflare/Turnstile/reCAPTCHA-v3** on European job sites by routing all browser automation through CloakBrowser.
- **Stay within ToS** for every source we use — default to public APIs; treat HTML scraping as a last resort with strict rate limits.

### Non-Goals (deliberately out of scope)

- LinkedIn Easy Apply autosubmit. The LinkedIn ToS forbids it; the legal risk outweighs the value.
- Account creation on candidates' behalf at new ATS portals. Persona reuses existing credentials only.
- Replacing the Chrome extension. Extension stays as the assisted/live-fill mode; the server worker is additive.
- Building a generic web-scraping platform. We scrape job listings, nothing else.

---

## 3. Target Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Next.js App (Vercel)                                                    │
│   • UI, auth, persona, resume, cover-letter, dashboard                   │
│   • Owns the Postgres / D1 source-of-truth                               │
│   • Enqueues discovery + apply jobs into Redis (BullMQ)                  │
└──────────────────────────────────────────────────────────────────────────┘
                              │ enqueue
                              ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Worker Service (Fly.io / Railway / Hetzner VPS)                         │
│                                                                          │
│  ┌─ Discovery Workers ─────────────────────────────────────────────┐    │
│  │  • greenhouse-source   (HTTP-only, no browser)                  │    │
│  │  • lever-source        (HTTP-only)                              │    │
│  │  • workday-source      (HTTP-only, CXS API)                     │    │
│  │  • smartrec-source     (HTTP-only)                              │    │
│  │  • personio-source     (HTTP-only, XML)                         │    │
│  │  • adzuna/reed/jsearch (existing API wrappers, kept)            │    │
│  │  • cloak-scrape-source (CloakBrowser, for Cloudflare sites)     │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─ Enrichment Pipeline ──────────────────────────────────────────┐    │
│  │  T1: JSON-LD JobPosting        (0 LLM tokens)                  │    │
│  │  T2: ATS CSS selector library  (0 LLM tokens)                  │    │
│  │  T3: LLM extraction (fallback) (≤ 1 LLM call per job)          │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─ Apply Workers (CloakBrowser pool) ────────────────────────────┐    │
│  │  • Per-user profile dir (cookies, fingerprint persisted)       │    │
│  │  • Pre-programmed flows: Workday, Greenhouse, Lever, ...       │    │
│  │  • AI fallback: Computer-Use Claude for unknown ATS            │    │
│  │  • Form-pattern cache: reuse mappings across users             │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────┘
```

### Why CloakBrowser (decision record)

| Option | Verdict | Reason |
|---|---|---|
| Stock Playwright + `playwright-stealth` | ❌ | JS-injection-based; detected by FingerprintJS and Cloudflare Turnstile. Breaks on every Chrome update. |
| Stock Puppeteer + `puppeteer-extra-plugin-stealth` | ❌ | Same class of issue. |
| Browserless / ScrapingBee (managed) | ⚠️ | Works but $$$ at scale; opaque; can't persist per-user state easily. |
| **CloakBrowser** | ✅ | C++ source-patched Chromium. MIT license. Drop-in Playwright API. Passes Cloudflare Turnstile, reCAPTCHA v3 0.9, BrowserScan. Supports per-profile fingerprints + proxies. |
| Anthropic Computer Use directly | ⚠️ | Powerful but slow (~30s/turn) and expensive. Reserved as fallback only. |

**Decision:** all server-side browser automation runs on CloakBrowser. AI fallback for unknown forms uses Anthropic Computer Use **inside** a CloakBrowser session.

---

## 4. ATS Coverage Matrix

This is the bedrock data structure. Every employer we add to the registry shows up in both discovery and apply.

| ATS | Discovery API | Apply Mode | EU Examples |
|---|---|---|---|
| **Greenhouse** | `boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` (full JD inline) | Pre-programmed flow | Booking.com, N26, GitLab, HelloFresh, Babbel, Blinkist |
| **Lever** | `api.lever.co/v0/postings/{company}?mode=json` | Pre-programmed flow | Spotify, Klarna, Tier Mobility, Personio (HR) |
| **Workday CXS** | `POST {tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` | Pre-programmed flow (5 stages) | SAP, Siemens, Volkswagen, Adidas, Allianz, Daimler |
| **SmartRecruiters** | `api.smartrecruiters.com/v1/companies/{company}/postings` | Pre-programmed flow | Bayer, Puma, Visa-EU (selected) |
| **SAP SuccessFactors** | `jobs.sap.com/career?site=...` (HTML, JSON-LD inside) | AI fallback (varied tenants) | SAP itself, Lufthansa, BASF |
| **Personio** | `{company}.jobs.personio.com/xml` | Pre-programmed flow | Mid-size German employers (very long tail) |
| **iCIMS / Taleo** | HTML scrape | AI fallback | Legacy ATS, common in industrial EU firms |

### Why public APIs are safe

Greenhouse, Lever, SmartRecruiters, Personio **publish these endpoints** on their developer docs — they exist for employer site embeds and partner integrations. Workday CXS is undocumented but stable, well-known, and used by many compliant projects (ApplyPilot, JobSpy). We rate-limit aggressively (≤ 5 RPS per ATS host) regardless.

---

## 5. Enrichment Cascade (cost containment)

Every job we discover needs a full description and a clean apply URL. The cascade routes 90% of jobs to zero-LLM paths.

```
discovered job
   │
   ▼
┌─────────────────────────────────────────────┐
│ T1: JSON-LD JobPosting extractor             │  ← 0 tokens
│  fetch HTML → parse <script type=ld+json>    │
│  if @type == JobPosting + description ≥ 200ch│
│  → done                                       │
└──────────────────┬──────────────────────────┘
                   │ miss
                   ▼
┌─────────────────────────────────────────────┐
│ T2: Known-ATS CSS selectors                  │  ← 0 tokens
│  workday: [data-automation-id="jobDescription"]│
│  greenhouse: .opening section                 │
│  lever: .section.posting-page                 │
│  if matches selector + length ≥ 200ch        │
│  → done                                       │
└──────────────────┬──────────────────────────┘
                   │ miss
                   ▼
┌─────────────────────────────────────────────┐
│ T3: LLM extraction                           │  ← ≤ 1 LLM call
│  send first 30KB of stripped HTML to Claude  │
│  prompt: extract jobDescription + applyUrl   │
└─────────────────────────────────────────────┘
```

The cascade reduces LLM spend on enrichment by an estimated 70–85%.

---

## 6. Auto-Apply Flow Architecture

### Three operating modes

| Mode | Trigger | Where it runs | Use case |
|---|---|---|---|
| **A. Assisted** | User clicks Apply in extension | User's Chrome | Sensitive forms, ambiguous fields, user wants control |
| **B. Semi-auto** | Extension auto-submit after user reviewed once | User's Chrome | Persona-stable forms, user delegated this employer |
| **C. Unattended** | Server worker picks up queued job | Worker server (CloakBrowser) | Standardized ATS, large batches, user is offline |

Modes A and B are already in the codebase. **This initiative focuses on Mode C.**

### Per-application sequence (Mode C)

```
1. Load apply task from queue
2. Acquire user's CloakBrowser profile (or initialize new one)
3. Navigate to apply URL via CloakBrowser
4. Detect ATS by URL/DOM fingerprint
5. Branch:
   ├─ Known ATS  → run pre-programmed flow (workday.ts / greenhouse.ts / ...)
   ├─ Cached pattern → replay field mapping from form_patterns table
   └─ Unknown    → AI driver (Computer Use inside CloakBrowser)
6. Fill fields from persona; upload tailored resume + cover letter
7. CAPTCHA check: CloakBrowser prevents most; if one appears → escalate
   ├─ CapSolver API (if key present)
   └─ Fall back to "manual" status, notify user via push
8. Submit (or dry-run if flag set)
9. Verify submission (URL change, success element, confirmation email check)
10. Persist storage_state (preserves cookies for next time)
11. Write outcome to apply_results table
```

### Pre-programmed flows: anatomy

Each flow is a single TypeScript module per ATS:

```typescript
// apps/worker/src/flows/workday.ts
export interface AtsFlow {
  matches(url: string, page: Page): Promise<boolean>
  apply(page: Page, task: ApplyTask): Promise<ApplyResult>
}
```

Flow modules are pure functions over `(page, task)`. They contain ATS-specific selectors and state-machine transitions. They are unit-tested against recorded HTML fixtures stored under `apps/worker/fixtures/`.

### Cross-user form-pattern cache

When the AI fallback successfully submits a form, it serializes the field mapping:

```typescript
{
  ats_type: 'unknown',
  company_slug: 'example-corp',
  url_pattern: '^https://careers\\.example\\.com/apply/.*$',
  field_mapping: [
    { selector: 'input[name="email"]', persona_path: 'email', kind: 'text' },
    { selector: 'select[name="country"]', persona_path: 'country', kind: 'select-by-text' },
    /* ... */
  ],
  success_count: 1,
  last_verified: '2026-05-21T10:00:00Z',
}
```

The next user applying to the same company short-circuits the AI driver and replays the mapping. After 10 successful replays the entry is marked "stable" and persists indefinitely; failures decrement a confidence counter and force re-derivation past a threshold.

This is **our differentiator** over ApplyPilot — they re-discover the form for every user.

---

## 7. Data Model Additions

New tables (Postgres / D1):

```sql
-- 7.1 Employer registry (source of truth for ATS discovery + apply)
CREATE TABLE ats_employers (
  id          SERIAL PRIMARY KEY,
  ats_type    TEXT NOT NULL,                       -- 'greenhouse' | 'lever' | 'workday' | ...
  slug        TEXT NOT NULL,                       -- per-ATS identifier
  name        TEXT NOT NULL,                       -- display name
  country     TEXT,                                -- ISO 3166-1 alpha-2
  meta        JSONB,                               -- workday tenant/site_id, etc.
  enabled     BOOLEAN DEFAULT TRUE,
  added_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (ats_type, slug)
);

-- 7.2 Form pattern cache (cross-user reuse)
CREATE TABLE form_patterns (
  id              SERIAL PRIMARY KEY,
  ats_type        TEXT NOT NULL,
  company_slug    TEXT NOT NULL,
  url_pattern     TEXT NOT NULL,                   -- regex
  field_mapping   JSONB NOT NULL,
  success_count   INT DEFAULT 0,
  failure_count   INT DEFAULT 0,
  last_verified   TIMESTAMPTZ,
  stable          BOOLEAN DEFAULT FALSE,
  UNIQUE (ats_type, company_slug, url_pattern)
);

-- 7.3 Apply results (full audit trail)
CREATE TABLE apply_results (
  id              SERIAL PRIMARY KEY,
  user_id         TEXT NOT NULL,
  job_id          TEXT NOT NULL,
  mode            TEXT NOT NULL,                   -- 'assisted' | 'semi' | 'unattended'
  ats_type        TEXT,
  flow_used       TEXT,                            -- 'workday' | 'ai-fallback' | 'pattern-cache'
  status          TEXT NOT NULL,                   -- 'submitted' | 'manual' | 'failed' | 'dry-run'
  verification    JSONB,                           -- screenshots, URL trail, confirmation email
  duration_ms     INT,
  error           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

Existing tables (`jobs`, `users`, `persona`, `resume`) remain unchanged except for a new `apply_status` column on `jobs` that mirrors the latest `apply_results` row.

---

## 8. Compliance & Safety

### Mandatory rules (enforced in code, not just docs)

1. **Rate limits per ATS host:** hard-coded ceiling, regardless of user count.
   - Greenhouse / Lever / SmartRecruiters / Personio public APIs: 5 RPS, 2× exponential backoff on 429.
   - Workday CXS: 1 RPS per tenant, 5 RPS aggregate.
   - HTML scrape sources: 1 RPS per host with random 5–15s jitter between page fetches.
2. **Per-user submit ceiling:** 30 unattended apply submissions per user per hour, 100 per day. Configurable per plan but never bypassable.
3. **Per-domain submit ceiling:** at most 5 applications per user per company per week. Stops accidental spam.
4. **No credential creation:** the worker never registers a new account on a candidate's behalf. If a flow requires login and no session cookie exists, the task is flagged "needs_user_action" and surfaces in the UI.
5. **robots.txt respected** for every HTML-scrape source. Blocked paths are skipped.
6. **No LinkedIn / Indeed auto-submit.** They are kept as discovery sources (via official APIs only); the apply queue refuses to dispatch tasks whose `apply_url` matches their domains.

### Sensitive data

- Resumes and persona answers never leave our backend. CloakBrowser runs on infrastructure we control.
- Per-user CloakBrowser profile dirs are encrypted at rest.
- Form-pattern cache stores only field mappings — no candidate data.

---

## 9. Observability

Every apply attempt produces:

- A row in `apply_results` (always).
- A trail of screenshots (compressed, 7-day retention).
- Network trace HAR (only on failure, 30-day retention for debugging).
- Structured log lines tagged with `apply_task_id`.

Dashboard widgets to add:

- Submission success rate per ATS (rolling 7-day).
- CAPTCHA encounter rate (target: < 1%; alerts at 5%).
- Median submission duration (target: < 30s for known ATS, < 90s for AI fallback).
- Per-source discovery counts (greenhouse / lever / workday / ...) — proves we're shifting off paid APIs.

---

## 10. Open Questions (to resolve before Phase 3)

1. **Worker hosting target.** Fly.io vs Railway vs Hetzner. Need a benchmark on per-application cost (CPU minutes × $) and EU-region latency. Lead: Codex spike, 1 day.
2. **Proxy provider.** Residential vs datacenter. CloakBrowser supports both. Residential improves stealth but costs 10×. Default: datacenter for ATS APIs, residential pool only for HTML-scraped sources flagged "anti-bot."
3. **Form-pattern cache invalidation strategy.** Time-based (90 days) vs failure-counter (3 strikes). Probably both, with separate paths.
4. **AI fallback budget cap.** Computer Use runs ~$0.10-0.25 per application. Hard cap per user per day? Or per-plan allowance?

These are tracked as discussion threads in the roadmap document.

---

## 11. Success Criteria

The initiative is "shipped" when all of the following are true on a single weekday's traffic:

- ≥ 50% of new jobs come from free ATS APIs (greenhouse / lever / workday / smartrec / personio).
- ≥ 80% of unattended apply attempts succeed end-to-end on Workday + Greenhouse + Lever.
- < 1% CAPTCHA encounter rate across all apply attempts.
- LLM enrichment spend ≤ 30% of pre-rollout baseline.
- No rate-limit-related complaints from any upstream source in a rolling 30-day window.

These criteria are baked into the milestone checklist in the roadmap.
