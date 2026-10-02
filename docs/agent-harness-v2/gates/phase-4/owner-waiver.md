# Phase 4 Gate — Owner-approved Phase 5 Implementation Waiver

**Original decision date:** 2026-09-01

**Latest gate reconciliation:** 2026-10-01

**Scope:** Phase 4 Exit Gate only; Phase 5 implementation activation

**Owner decisions:** Waive the 48h dual-write observation (2026-09-01) and V3 staging approval/decline/expiry browser smoke (2026-10-01) for Phase 5 implementation activation; retain the SSE reconnect evidence requirement.

## Decision

| Decision | Result |
|---|---|
| Existing owner waiver | **Names Phase 5 as eligible for conditional activation** |
| Ordinary evidence-complete Gate | **Not claimed** |
| V3 staging approval/decline/expiry browser smoke | **WAIVED / NOT VERIFIED** |
| 48h dual-write integrity observation | **WAIVED / NOT VERIFIED** |
| V3 SSE disconnect/reconnect replay item | **OBSERVED / OWNER-ACCEPTED** |
| Current #387 / Phase 5 activation state | **GO by owner waiver for Phase 5 implementation only; recorded 2026-10-01 in #387 comment 5932720327** |
| Production rollout or flag promotion | **Not authorized by this waiver** |

This document records an explicit owner exception. It does not manufacture a 48h measurement, convert a missing report into a PASS, or remove the two-person approval control for high-risk configuration changes.

## Evidence already available

- Phase 4 implementation and code-level verification are merged through AH2-021: PRs [#382](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/382), [#383](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/383), [#384](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/384), and [#385](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/385).
- The runbook and gate evidence package are merged in PRs [#389](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/389) and [#390](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/390).
- Historical staging approval-control and SSE evidence are recorded in PR [#392](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/392). Per the newer owner decision below, the required V3 approval/decline/expiry staging browser smoke is waived and remains unverified; do not treat PR #392's partial synthetic fixture evidence as a full pass.
- The SSE portion of PR #392 is separately accepted for the named replay requirement by the owner's [2026-10-01 ruling](https://github.com/YuanshuoDu/applymate-jobcopilot/issues/387#issuecomment-5929863153). The trace is linked from [#387](https://github.com/YuanshuoDu/applymate-jobcopilot/issues/387#issuecomment-5494777399); its synthetic durable event and lack of Worker/Redis execution remain explicit limitations.
- On the staging Preview observed on 2026-09-01, the Agent page completed a synthetic, non-application request using the configured CN MiniMax path: `Reply only: CN MiniMax smoke OK.` The UI recorded a completed chat, an Auditor task with `Passed · 80% confidence`, and no pending application approval. The Preview branch commit at that time was `c15e4e996701bc55d83df82db13fd51d44e2742a`.
- A 2026-09-01 authenticated admin Platform controls observation reported `AGENT_PROTOCOL_V2_DUAL_WRITE` as `Active` in Staging, `Enabled`, `100%`, version `v3`, and `fantasticjobs_shadow` as `Active` in Production, `Enabled`, `0%`, version `v3`. These are historical values only. Later staging checks found a control-plane/database binding mismatch and no current feature-flag records; neither value is asserted as current in this report.

## Latest owner decision and Phase 4 disposition (2026-10-01)

The owner explicitly [waived the V3 staging approval/decline/expiry browser smoke and the V5 48-hour dual-write report](https://github.com/YuanshuoDu/applymate-jobcopilot/issues/387#issuecomment-5931612168). Both checks were not run for this gate decision and must remain `WAIVED / NOT VERIFIED`; neither may be shown as PASS. The owner retained the staging SSE disconnect/reconnect item. The already attached PR #392 trace meets that item as [ruled by the owner](https://github.com/YuanshuoDu/applymate-jobcopilot/issues/387#issuecomment-5929863153), so it must not be rerun merely to duplicate evidence.

The 2026-10-01 §1.8 decision recorded in #387 comment 5932720327 is **GO under the owner waiver for Phase 5 implementation only**. The staging approval/decline/expiry browser smoke and 48-hour dual-write report remain `WAIVED / NOT VERIFIED`. The separate Worker-originated original-Turn wakeup runtime gap remains **UNVERIFIED** and is accepted under the named approval-smoke waiver for Phase 5 implementation only; the worker/Redis producer path was not exercised by the SSE replay trace, and this runtime item must be re-verified before any staging or production activation. Phase 4 is not evidence-complete `completed`; staging control-plane/database binding and the #519 audit-chain deployment readback remain unverified. Production rollout and flag promotion remain **NO-GO**; this decision does not authorize staging flag mutation or bypass later Phase 5 gates.

## Explicitly waived items

The following items are waived for Phase 5 implementation activation:

- **V3 staging approval/decline/expiry browser smoke:** owner-waived on 2026-10-01; `WAIVED / NOT VERIFIED`. It was not run for the current Gate decision.
- **48-hour dual-write integrity observation/report (§1.7).**

No claim is made that either item passed. No claim is made about parity over the 48-hour period. In particular, the project has no empirical 48-hour trend for event counts, projection counts, orphan records, duplicate records, lag, or error rate under this decision.

## Controls that remain mandatory

This exception does not waive any of the following:

1. Deterministic policy enforcement and fail-closed behavior.
2. Approval receipt scope, expiry, nonce, revision, race, and replay checks.
3. Owner separation for approval; the flag creator must not approve their own change.
4. PII, secret, token, raw resume, and sensitive-answer redaction.
5. Staging-only validation until an independently approved rollout exists. The staging control-plane/database/deployment binding must be freshly reconciled before enabling flags or starting an observation window; the last recorded check did not establish agreement.
6. Phase 5 unit, integration, fault, browser, and runtime Exit Gate evidence.
7. A rollback owner, trigger, and restoration procedure before any production activation.

## Risk acceptance and follow-up

### Accepted risks

- The system has not observed dual-write integrity continuously for 48 hours.
- Short-lived drift, delayed projection, or an orphan record could exist outside the tested windows.
- The 48-hour integrity window has no empirical result.
- Current staging flag values are unknown; the 2026-09-01 active observation is historical, and later readback reported the flag as retired/no current feature flags.
- The #519 audit-chain repair is merged, but its migration application and post-deployment health/checkpoint readback were not verified in the 2026-10-01 audit.

### Required follow-up

- Keep [#387](https://github.com/YuanshuoDu/applymate-jobcopilot/issues/387) and [#388](https://github.com/YuanshuoDu/applymate-jobcopilot/issues/388) as the audit trail for the deferred evidence and owner decision.
- Do not represent Phase 5 merges as retroactive evidence that Phase 4 had a 48h PASS.
- When operationally valuable, an authorized operator may run the 48h observation only after fresh staging control-plane/database binding verification; this is follow-up evidence, not a prerequisite for Phase 5 implementation under the owner waiver.
- Complete read-only post-#519 deployment and audit checkpoint verification through the authorized operational process before treating the admin audit repair as live-verified.
- Revoke or pause the waiver if staging shows policy bypass, scope leakage, PII exposure, duplicate external writes, or unexplained dual-write divergence.

## Reviewer handoff

`@claude` should review the linked §1.8 Exit Report, which records the formal decision as **GO by owner waiver for Phase 5 implementation only** in #387 comment 5932720327 on 2026-10-01. The staging approval smoke and 48-hour integrity report remain `WAIVED / NOT VERIFIED`, the SSE replay item is observed and owner-accepted, and Phase 4 is not evidence-complete `completed`. Production rollout and flag promotion remain **NO-GO** pending their own evidence and approval.
