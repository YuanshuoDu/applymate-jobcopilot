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

A subsequent discovery — [`CloakBrowser`](https://github.com/CloakHQ/CloakBrowser) — provides a Playwright-compatible browser runtime with per-user profile support. It may improve compatibility, but it does not guarantee access to a protected site and it is never used to bypass a CAPTCHA, login wall, MFA, or other platform control.

This document is the plan to build on those primitives.

---

## 2. Goals & Non-Goals

### Goals (in scope for this initiative)

- **Cut RapidAPI spend ≥ 70%** by routing the bulk of discovery through free ATS APIs and direct scraping.
- **Reach 200+ EU employer coverage** via Workday / Greenhouse / Lever / SmartRecruiters / Personio registries.
- **Ship a server-side worker** that can submit applications without the user's browser being open.
- **Achieve ≥ 80% auto-submission success on standardized ATS** (Workday, Greenhouse, Lever) via pre-programmed flows.
- **Handle browser challenges safely:** detect Cloudflare/Turnstile/reCAPTCHA and pause for user takeover; routing through CloakBrowser must never be treated as a challenge bypass.
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
| **CloakBrowser** | ✅ | Playwright-compatible browser runtime with per-user profiles and proxy configuration. It may improve compatibility, but challenge detection remains authoritative and detection-only. |
| Anthropic Computer Use directly | ⚠️ | Powerful but slow (~30s/turn) and expensive. Reserved as fallback only. |

**Decision:** all server-side browser automation runs on CloakBrowser. AI fallback for unknown forms uses Anthropic Computer Use **inside** a CloakBrowser session.

---

## 4. ATS Coverage Matrix

This is the bedrock data structure. Every employer we add to the registry shows up in both discovery and apply.

| ATS | Discovery API | Apply Mode | EU Examples |
|---|---|---|---|
| **Greenhouse** | `boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` (full JD inline) | Pre-programmed flow | Booking.com, N26, GitLab, HelloFresh, Babbel, Blinkist |
| **Lever** | `api.lever.co/v0/postings/{company}?mode=json` | Pre-programmed flow | Spotify, Klarna, Tier Mobility, Personio (HR) |
| **Workday CXS** | `POST {tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` | Pre-programmed flow (5 stages) | Employer-specific; registry entries require live verification |
| **SmartRecruiters** | `api.smartrecruiters.com/v1/companies/{company}/postings` | Pre-programmed flow | Bayer, Puma, Visa-EU (selected) |
| **SAP SuccessFactors** | `jobs.sap.com/career?site=...` (HTML, JSON-LD inside) | AI fallback (varied tenants) | SAP itself, Lufthansa, BASF |
| **Personio** | `{company}.jobs.personio.com/xml` | Pre-programmed flow | Mid-size German employers (very long tail) |
| **Ashby** | `GET api.ashbyhq.com/posting-api/job-board/{board}` (full description inline) | AI fallback (discovery-only initially) | OpenAI, Ramp, Notion, DeepL, Deliveroo, Miro |
| **iCIMS / Taleo** | HTML scrape | AI fallback | Legacy ATS, common in industrial EU firms |

> **Registry maintenance (2026-08-24):** the current Workday employer registry is
> quarantined until each tenant/siteId pair is re-verified against a live CXS
> endpoint. All 33 catalogued entries currently return HTTP 401/404/422. SAP's
> public careers site now runs on SuccessFactors at `jobs.sap.com`; it must not
> be treated as a Workday CXS tenant until a dedicated SuccessFactors source is
> maintained.

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
7. Challenge check before any flow and before any submit
   ├─ CAPTCHA detected → `manual`, checkpoint `user_takeover`, notify user
   ├─ Login/MFA detected by the harness → the same `waiting_for_user` boundary
   ├─ Challenge detection errors → `manual`, checkpoint `user_takeover`
   └─ No challenge signal → continue without attempting to bypass platform controls
8. Submit only when the existing runtime authorization guard allows it (or dry-run)
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
  status          TEXT NOT NULL,                   -- 'submitted' | 'manual' | 'failed' | 'submission_blocked' | 'dry-run'
  verification    JSONB,                           -- screenshots, URL trail, confirmation email
  duration_ms     INT,
  error           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

Existing tables (`jobs`, `users`, `persona`, `resume`) remain unchanged except for a new `apply_status` column on `jobs` that mirrors the latest `apply_results` row.

---

## 8. Compliance & Safety

### External-action safety matrix

This matrix is the Phase 0 inventory for every action that can affect a third-party system, upload candidate data, schedule future work, or record a claim that an external action occurred. A read-only provider call is included where it shares credentials or can trigger a provider-side state change.

| Action and entry point | External target / effect | Risk | Approval boundary | Idempotency key or guard | Retry policy | Owner and enforcement |
|---|---|---|---|---|---|---|
| Resume ingestion: `POST /api/resume/intake`, `POST /api/resume` | ApplyMate storage and model provider; the intake route parses the candidate file/text and does not publish it to an employer | High privacy, no employer-side effect | User-initiated upload; AI parsing is not submission consent | Authenticated `userId`; resume/job ownership checks | Safe user retry after an extraction/provider error; rate limited; never retries an external submission | Web resume routes and `ModelRouter`; no Worker submit path is implied |
| Manual application record: `POST /api/jobs/[id]/apply` | Records that the candidate already applied outside ApplyMate | Medium data-integrity risk; does not send to the employer | Candidate explicitly reports a completed manual application | Job is scoped to the authenticated `userId`; one job row is updated | No automatic replay; a duplicate request is a state write, not a new employer submission | Web route; database ownership check |
| Extension-assisted fill: `apps/extension/src/content/form-injector.ts`, `apps/extension/src/lib/form-filler/auto-fill.ts` | ATS form DOM and optional ATS-hosted file upload; the candidate remains on the employer page | High privacy; no unattended submit | Candidate clicks the extension action and reviews the result; candidate submits manually | Extension has no final-submit authority; the browser page remains user-controlled | No background retry; candidate can rescan or refill deliberately | Chrome Extension; no Worker submission path |
| Fill-only application pass: `/api/agent/application-tasks`, `/api/agent/sessions/[id]/actions` `review_application`, admin review action → `queueApplicationFill` → `apply-tasks(operation=fill)` | ATS form DOM and ATS-hosted file upload; no final submit | High privacy; candidate material reaches the ATS form | Review approval permits form filling only; `allowSubmit=false` and no submit authorization | `applicationTaskId` state transition plus authenticated user/job ownership | No automatic replay once a browser attempt starts; user can request a new review pass | Web queue client + Worker flows/Harness; fill-only tests |
| Legacy auto-apply request: `POST /api/jobs/[id]/auto-apply` | No external effect; the endpoint rejects direct job-page auto-apply requests | Low external risk; important fail-closed boundary | Agent-session review and approval are required instead | Job ownership check followed by an unconditional conflict response | No retry; it must not enqueue a submit task | Web route; explicit 409 guard |
| Unattended application submit: `/api/agent/application-tasks` approval creation, `/api/agent/sessions/[id]/actions` approved `submit_application` → `queueAutonomousApplication` → `apply-tasks(operation=submit)` | ATS final submit and employer application record | Critical, irreversible external action | Explicit per-job approval; global settings never substitute for it | Approval payload binds `approvalId`, task, user and job; `claimUnattendedSubmission`; `assertSubmissionAuthorized` at every submit call site | No automatic retry after browser start, uncertain result, CAPTCHA, login, MFA, or challenge-detection failure; only deliberate human/admin review | Web control plane + Worker queue/flows/pattern/Harness; fail-closed gate from AH2-001 |
| Gmail OAuth connect: `/api/gmail/oauth/start` → `/api/gmail/oauth/callback` | Google OAuth grants and ApplyMate credential storage | High credential/privacy risk | User completes Google consent; signed state, nonce, session and auth-version checks | OAuth state is browser-bound and user-bound; provider account identity is checked before upsert | User must restart/re-authorize; no background replay of a consent exchange | Web Gmail OAuth routes; encrypted account tokens |
| Gmail read/sync: `/api/gmail/tracking?refresh=1`, `syncGmailForUser`, Agent audit stage | Reads job-related messages and writes normalized tracking/recommendation records; does not send or modify Gmail | High privacy, no send effect | Prior Gmail read consent; user-scoped connection | Gmail message/thread IDs and sync state prevent duplicate imports; every DB query is user-scoped | Provider-transient retry only; never converts a read failure into a send or apply action | Web Gmail tracking/sync service |
| Gmail draft generation: `POST /api/gmail/ai-reply` | Model provider generates text; ApplyMate records a local activity; it does not send Gmail | Medium privacy/content risk | User requests a draft; sending is a separate action | `jobId` ownership check; no send side effect | Safe to regenerate; no Gmail send retry | Web route + ModelRouter |
| Gmail send: `POST /api/gmail/send-draft` → `users/me/messages/send` | Sends an email to an employer from the user’s Gmail | Critical external communication | Separate user confirmation in the follow-up UI; AH2-019 may add a durable receipt later | Gmail API has no request idempotency key in this route; do not retry an ambiguous response | No automatic retry and no client retry without fresh user confirmation | Web route; provider usage ledger; send is never called by the Worker apply loop |
| ApplyMate notification email: Worker `notifyApplyResult`, `POST /api/contact`, `POST /api/notifications/daily`, password-reset and broadcast delivery services | Sends status, support, or account email through Resend; cannot submit an application or change ATS state | Medium communication risk | Product notification preference, account workflow, or support request | Notification is non-blocking and must not be used as an action authorization | Best effort; provider failure is logged and never triggers ATS replay | Worker/Web notification services |
| Automation create/update/delete/run: `/api/agent/automations`, `/api/agent/automations/[id]`, `/api/agent/automations/[id]/run`, session `create_automation`, signed `/api/agent/automations/due` | Mutates scheduled automation state and may schedule future discovery/apply work | High future-action risk | Authenticated user action; autonomous execution still passes the per-job approval boundary | `(automationId,userId)` ownership; atomic due-run claim; canonical automation session/execution | Scheduler may revisit an unclaimed due run; never duplicate an accepted execution; mutation errors require a new request | Web automation routes + Worker scheduler; signed cron secret for due runs |
| Admin queue control: `/api/admin/v1/queues/[queue]/retry` and pause/resume routes | Replays, pauses, or resumes Worker jobs | High operational risk; can cause duplicate external activity | Admin authentication and deliberate operator action | Queue/job IDs; inspect task/result state before retry | Never bulk-retry CAPTCHA, login, MFA, or ambiguous browser failures | Admin control plane + runbook |

The matrix deliberately distinguishes “form fill/upload” from “final submit”. Uploading a resume to an ATS is still a privacy-sensitive external write, but it is not permission to submit. Every challenge boundary uses the same persisted checkpoint, `user_takeover`, and the Worker returns normally so BullMQ does not schedule an automatic retry.

### Negative-fixture evidence

The matrix is backed by these existing and AH2-002 regression fixtures:

| Action class | Negative fixture | Required assertion |
|---|---|---|
| ATS submit / browser fallback | `apps/worker/src/queue/apply-queue-captcha.test.ts`, `apps/worker/src/queue/apply-queue-pipeline.test.ts`, and the five `*-flow.test.ts` files | Challenge, missing authorization, or revoked authorization produces no click/submit; task remains reviewable and is not replayed |
| ATS resume or cover-letter upload | `apps/worker/src/harness/agent-harness.test.ts` and fill-only cases in `apps/worker/src/queue/apply-queue-pipeline.test.ts` | Upload path is constrained to the task material; fill-only work has no submit authorization and submit-like clicks do not execute |
| Gmail send | `apps/web/src/app/api/gmail/send-draft/route.test.ts` | Provider rejection returns a stable error and does not write the “email sent” activity |
| Resume ingestion | `apps/web/src/app/api/resume/intake/route.test.ts` | Disabled or exhausted AI access rejects the intake before parsing/persistence |
| Automation mutation and dispatch | `apps/web/src/app/api/agent/automations/route.test.ts` and `apps/worker/src/queue/automation-scheduler.test.ts` | Same-name automation is updated rather than duplicated; protected scheduler failures remain observable without leaking provider details |

The extension-assisted path is intentionally user-driven: it can fill fields but has no unattended submit capability. Its final employer-page submit is therefore outside the Worker replay boundary.

### Mandatory rules (enforced in code, not just docs)

1. **Rate limits per ATS host:** hard-coded ceiling, regardless of user count.
   - Greenhouse / Lever / SmartRecruiters / Personio public APIs: 5 RPS, 2× exponential backoff on 429.
   - Workday CXS: 1 RPS per tenant, 5 RPS aggregate.
   - HTML scrape sources: 1 RPS per host with random 5–15s jitter between page fetches.
2. **Per-user submit ceiling:** 30 unattended apply submissions per user per hour, 100 per day. Configurable per plan but never bypassable.
3. **Challenge handling is detection-only:** CAPTCHA, login walls, MFA, verification-code prompts, and challenge-detector errors become `manual` / `waiting_for_user` with checkpoint `user_takeover`.
4. **No challenge bypass or retry:** no solver, token injection, automatic challenge completion, or automatic retry may be configured or called. An operator must inspect the task before any deliberate retry.
5. **Per-domain submit ceiling:** at most 5 applications per user per company per week. Stops accidental spam.
6. **No credential creation:** the worker never registers a new account on a candidate's behalf. If a flow requires login and no session cookie exists, the task uses `waiting_for_user` with checkpoint `user_takeover` and surfaces in the UI.
7. **robots.txt respected** for every HTML-scrape source. Blocked paths are skipped.
8. **No LinkedIn / Indeed auto-submit.** They are kept as discovery sources (via official APIs only); the apply queue refuses to dispatch tasks whose `apply_url` matches their domains.

### Sensitive data

- Resumes and persona answers leave our backend only through an explicitly approved ATS form/upload or the configured model provider. CloakBrowser runs on infrastructure we control.
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
