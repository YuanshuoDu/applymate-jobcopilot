# Scraping & Auto-Apply — Implementation Roadmap

> **Status:** Draft v1 · 2026-05-21
> **Related:** [`scraping-autoapply-design.md`](./scraping-autoapply-design.md), [`scraping-autoapply-dev-guide.md`](./scraping-autoapply-dev-guide.md)

This is the execution plan. The design document explains **what** we're building; this document explains **the order**, **the dependencies**, and **the exit criteria for each phase**. Each row below maps to a GitHub Issue tagged `spec-ready` once the spec is written and reviewed.

---

## Reading order

1. Read [`scraping-autoapply-design.md`](./scraping-autoapply-design.md) once, top to bottom.
2. Read this roadmap to understand phase boundaries.
3. Open the issue you're assigned and proceed under the rules in [`scraping-autoapply-dev-guide.md`](./scraping-autoapply-dev-guide.md).

---

## Phase 0 — Foundations (this PR)

| # | Deliverable | Type | State |
|---|---|---|---|
| 0.1 | Design document committed (`scraping-autoapply-design.md`) | docs | ✅ this PR |
| 0.2 | Roadmap document committed (this file) | docs | ✅ this PR |
| 0.3 | Dev guide committed (`scraping-autoapply-dev-guide.md`) | docs | ✅ this PR |
| 0.4 | Phase 1–4 issues created with specs | process | ✅ this PR |

Exit criteria: docs PR merged to master, Phase 1 issues all in `spec-ready` state.

---

## Phase 1 — Free ATS APIs + Enrichment Cascade (Week 1)

**Goal:** prove the cost-cutting thesis. After this phase ≥ 30% of new jobs should come from free APIs, with no LLM call on enrichment for the majority.

| # | Issue | Type | Depends on | Effort |
|---|---|---|---|---|
| 1.1 | Greenhouse public boards API source | `feat` | — | 1 day |
| 1.2 | Lever public postings API source | `feat` | — | 1 day |
| 1.3 | EU employer seed registry (greenhouse + lever) | `feat` | 1.1, 1.2 | 0.5 day |
| 1.4 | JSON-LD JobPosting extractor (T1 cascade) | `feat` | — | 1 day |
| 1.5 | Known-ATS CSS selector library (T2 cascade) | `feat` | 1.4 | 1 day |
| 1.6 | Wire cascade into existing enrich endpoint | `refactor` | 1.4, 1.5 | 0.5 day |

**Exit criteria** (verifiable in dashboard):
- A dev run of `pnpm scout:eu` populates ≥ 200 new jobs from greenhouse + lever in < 5 min.
- ≥ 70% of those jobs have `full_description` populated via T1 or T2 (no LLM hit).
- All six issues closed; no regression in existing scout pipeline tests.

---

## Phase 2 — Workday + Long-Tail ATS Discovery (Week 2)

**Goal:** unlock the European corporate market by adding Workday and the long-tail ATSes most common to mid-size EU employers.

| # | Issue | Type | Depends on | Effort |
|---|---|---|---|---|
| 2.1 | Workday CXS API client + paginated search | `feat` | — | 2 days |
| 2.2 | EU Workday tenant registry (SAP, Siemens, ...) | `feat` | 2.1 | 0.5 day |
| 2.3 | SmartRecruiters API source | `feat` | — | 1 day |
| 2.4 | Personio XML source | `feat` | — | 1 day |
| 2.5 | Multi-source dedup by `(company_norm, title_norm, location_norm)` | `feat` | 1.1, 1.2, 2.1, 2.3, 2.4 | 1 day |
| 2.6 | CloakBrowser PoC + smoke test against StepStone / LinkedIn / Turnstile sites | `chore` | — | 1 day |

**Exit criteria:**
- ≥ 100 EU employers in the registry across all ATS types.
- Workday CXS scrapes 5 employers in < 60 s aggregate.
- Dedup table proves at least one cross-source merge per day.
- CloakBrowser PoC report posted in issue 2.6 with PASS/FAIL on each target site.

---

## Phase 3 — Server-Side Worker Infrastructure (Week 3)

**Goal:** stand up the worker service that will host all unattended applications. No flows yet — just the platform.

| # | Issue | Type | Depends on | Effort |
|---|---|---|---|---|
| 3.1 | Worker service skeleton (Node.js, BullMQ, Redis) | `feat` | — | 2 days |
| 3.2 | CloakBrowser pool + per-user profile manager | `feat` | 3.1, 2.6 | 2 days |
| 3.3 | Storage-state persistence (encrypted cookies / localStorage) | `feat` | 3.2 | 1 day |
| 3.4 | `apply_results` schema + dashboard widget | `feat` | 3.1 | 1 day |
| 3.5 | Deploy worker to staging (Fly.io or chosen target) | `chore` | 3.1–3.4 | 1 day |
| 3.6 | Rate-limit middleware (per user / per host / per ATS) | `feat` | 3.1 | 1 day |

**Exit criteria:**
- Worker accepts a dry-run apply task end-to-end against a staging URL and writes a row to `apply_results`.
- Per-user profile picks up where it left off (cookie persists across worker restarts).
- Rate-limit middleware blocks the 31st apply attempt within an hour with a clear error code.
- Staging deploy URL recorded in issue 3.5.

---

## Phase 4 — Pre-Programmed ATS Flows (Week 4)

**Goal:** ship the flows that cover ≥ 80% of unattended traffic. Each flow has a fixture-backed test.

| # | Issue | Type | Depends on | Effort |
|---|---|---|---|---|
| 4.1 | Workday apply flow (full 5-stage wizard) | `feat` | 3.5, 2.1 | 3 days |
| 4.2 | Greenhouse apply flow | `feat` | 3.5, 1.1 | 2 days |
| 4.3 | Lever apply flow | `feat` | 3.5, 1.2 | 1 day |
| 4.4 | SmartRecruiters apply flow | `feat` | 3.5, 2.3 | 1 day |
| 4.5 | ATS detector (URL/DOM fingerprint → flow selector) | `feat` | 4.1–4.4 | 1 day |
| 4.6 | Dry-run verification harness (no submit, prove fill correctness) | `feat` | 4.1 | 1 day |

**Exit criteria:**
- Each flow passes its fixture-backed unit test in CI.
- A staging dry-run against one real apply URL per ATS completes successfully (proof: screenshot in issue comments).
- ATS detector misclassification rate < 5% on a holdout set of 50 real URLs.

---

## Phase 5 — AI Fallback + Pattern Cache (Week 5)

**Goal:** handle the long tail of unknown forms; build the moat (cross-user pattern reuse).

| # | Issue | Type | Depends on | Effort |
|---|---|---|---|---|
| 5.1 | AI fallback driver (Computer Use inside CloakBrowser) | `feat` | 3.5 | 3 days |
| 5.2 | Form-pattern cache schema + write path | `feat` | 5.1 | 1 day |
| 5.3 | Pattern replay path (skip AI when cache hit) | `feat` | 5.2 | 1 day |
| 5.4 | Confidence decay + invalidation on consecutive failures | `feat` | 5.3 | 0.5 day |
| 5.5 | Per-user AI fallback budget cap | `feat` | 5.1 | 0.5 day |

**Exit criteria:**
- One AI-driven submission completes end-to-end against a real (non-blacklisted) form, in dry-run mode.
- Cache hit on second submission to same company short-circuits the AI driver (proof: log shows `flow=pattern-cache`).
- Budget cap blocks the user after configured threshold with a clear UX message.

---

## Phase 6 — Direct HTML Scraping for Anti-Bot Sites (Week 6, optional)

**Goal:** replace paid LinkedIn/StepStone/Xing API calls where compliance allows.

| # | Issue | Type | Depends on | Effort |
|---|---|---|---|---|
| 6.1 | Compliance review: which sites are scrapeable under their ToS | `docs` | — | 0.5 day |
| 6.2 | StepStone DE/AT scrape source (CloakBrowser) | `feat` | 3.2, 6.1 | 2 days |
| 6.3 | Xing scrape source (CloakBrowser) | `feat` | 3.2, 6.1 | 2 days |
| 6.4 | Welcome to the Jungle scrape source (CloakBrowser) | `feat` | 3.2, 6.1 | 1 day |
| 6.5 | Decommission RapidAPI plans that are now redundant | `chore` | 6.2–6.4 | 0.5 day |

**Exit criteria:**
- All scraped sites respect robots.txt and our 1-RPS-per-host rule.
- Decommission saves visible at the next billing cycle.
- Compliance memo in 6.1 signed off by whoever owns legal.

---

## Phase 7 — Production Hardening (Week 7)

| # | Issue | Type | Depends on | Effort |
|---|---|---|---|---|
| 7.1 | Proxy pool integration (residential for HTML, datacenter for APIs) | `feat` | 3.2 | 1.5 days |
| 7.2 | CAPTCHA fallback to CapSolver (escape hatch) | `feat` | 4.6 | 1 day |
| 7.3 | Push notification when task needs user action (manual escalation) | `feat` | 3.4 | 1 day |
| 7.4 | Observability dashboard (success rate, CAPTCHA rate, source mix) | `feat` | 3.4 | 1.5 days |
| 7.5 | Runbook for on-call: stalls, ATS structure changes, captcha spikes | `docs` | 7.4 | 0.5 day |

**Exit criteria:**
- Dashboard hits all four success criteria from §11 of the design doc.
- Runbook reviewed by anyone who is not the original author.

---

## Dependency Graph (TL;DR)

```
Phase 1 ─┬─► Phase 2 (extends sources)
         │
         └─► Phase 4 (flows depend on registry from Phase 1+2)

Phase 2.6 (CloakBrowser PoC) ─► Phase 3 (worker uses CloakBrowser) ─► Phase 4 / 5 / 6

Phase 4 ─► Phase 5 (AI fallback)
Phase 4 ─► Phase 6 (HTML scrape reuses worker pool)

Phase 7 ◄── everything (observability + hardening at end)
```

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Workday tenants block our IP after a burst | Medium | High | Aggressive backoff; rotate user-agent; proxy pool from Phase 7.1 |
| CloakBrowser binary download fails in CI | Low | Medium | Pin version in lockfile; mirror binary to our own S3 if needed |
| ATS changes form structure mid-flow | Medium | High | Fixture-backed tests catch breakage; pattern cache decays on failures |
| Legal challenge on HTML scrape sources | Low | High | Phase 6.1 review; default to public API where one exists |
| Worker server OOMs on parallel CloakBrowser instances | Medium | Medium | Hard cap on concurrent contexts; Phase 7.4 dashboard surfaces it |
| AI fallback runaway cost | Low | Medium | Phase 5.5 budget cap; per-task max-turns guard |

---

## Cost Envelope (post-rollout estimate)

| Item | Pre-rollout | Post-rollout |
|---|---|---|
| RapidAPI subscriptions | ~$200 / mo | ~$30 / mo (keep one fallback plan) |
| LLM enrichment | scales with discovery | -75% (T1+T2 cover 90%) |
| LLM apply (AI fallback) | $0 | +$30–80 / mo (capped per user) |
| Worker server (Fly.io 2vCPU/4GB) | $0 | +$25 / mo |
| Proxy pool (datacenter, optional residential) | $0 | +$30–150 / mo |
| **Net change at 500-user scale** | | **net ~ −$50/mo** + far better data freshness |

The numbers above are rough; reconcile them after Phase 3 staging deploy with real usage data.

---

## How to Use This Roadmap

- **Phase boundaries are real.** Do not start Phase 4 issues while Phase 3 is open — the dependencies are load-bearing.
- **Issues are sized for ≤ 1 PR.** If an estimate balloons past 2 days during implementation, split the issue.
- **Update this file when a phase exits.** Move "Exit criteria" lines from intent to evidence, link the merged PRs.
- **The design doc is upstream.** If implementation reveals a wrong assumption, update the design doc first, then thread the change through this roadmap.
