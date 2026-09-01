# Phase 4 Gate — Owner-approved 48h Observation Waiver

**Decision date:** 2026-09-01  
**Scope:** Phase 4 Exit Gate only; Phase 5 implementation activation  
**Owner decision:** Accept the 48h dual-write observation requirement as waived so Phase 5 can proceed without waiting 48 hours.

## Decision

| Decision | Result |
|---|---|
| Phase 4 operational activation | **GO BY OWNER WAIVER** |
| Ordinary evidence-complete Gate | **Not claimed** |
| 48h dual-write integrity observation | **WAIVED / NOT VERIFIED** |
| Phase 5 implementation | **Unlocked under this named exception** |
| Production rollout or flag promotion | **Not authorized by this waiver** |

This document records an explicit owner exception. It does not manufacture a 48h measurement, convert a missing report into a PASS, or remove the two-person approval control for high-risk configuration changes.

## Evidence already available

- Phase 4 implementation and code-level verification are merged through AH2-021: PRs [#382](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/382), [#383](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/383), [#384](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/384), and [#385](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/385).
- The runbook and gate evidence package are merged in PRs [#389](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/389) and [#390](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/390).
- Staging approval-control and SSE evidence are recorded in PR [#392](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/392). Those records establish the tested behavior and its stated boundaries; they do not establish a 48h observation window.
- On the current staging Preview, the Agent page completed a synthetic, non-application request using the configured CN MiniMax path: `Reply only: CN MiniMax smoke OK.` The UI recorded a completed chat, an Auditor task with `Passed · 80% confidence`, and no pending application approval. The current Preview branch commit was `c15e4e996701bc55d83df82db13fd51d44e2742a`.
- The authenticated admin Platform controls page was rechecked after approval. `AGENT_PROTOCOL_V2_DUAL_WRITE` is now `Active` in Staging with `Enabled`, `100%` rollout for all plans, and version `v3`. No self-approval or database bypass was attempted.
- The same page shows `fantasticjobs_shadow` as `Active` in Production with `Enabled`, `0%` rollout for all plans, and version `v3`; its active configuration receives no production traffic.

## Explicitly waived item

The following item is waived for Phase 5 activation:

- **AC2 / §1.7:** a 48h staging dual-write integrity observation and report.

No claim is made about parity over that period. In particular, the project has no empirical 48h trend for event counts, projection counts, orphan records, duplicate records, lag, or error rate under this decision.

## Controls that remain mandatory

This exception does not waive any of the following:

1. Deterministic policy enforcement and fail-closed behavior.
2. Approval receipt scope, expiry, nonce, revision, race, and replay checks.
3. Owner separation for approval; the flag creator must not approve their own change.
4. PII, secret, token, raw resume, and sensitive-answer redaction.
5. Staging-only validation until an independently approved rollout exists.
6. Phase 5 unit, integration, fault, browser, and runtime Exit Gate evidence.
7. A rollback owner, trigger, and restoration procedure before any production activation.

## Risk acceptance and follow-up

### Accepted risks

- The system has not observed dual-write integrity continuously for 48 hours.
- Short-lived drift, delayed projection, or an orphan record could exist outside the tested windows.
- The 48-hour integrity window still has no empirical result; the staging dual-write flag is now active at 100% under the owner waiver.

### Required follow-up

- Keep [#387](https://github.com/YuanshuoDu/applymate-jobcopilot/issues/387) and [#388](https://github.com/YuanshuoDu/applymate-jobcopilot/issues/388) as the audit trail for the deferred evidence and owner decision.
- Do not represent Phase 5 merges as retroactive evidence that Phase 4 had a 48h PASS.
- When operationally valuable, run the 48h observation from the now-active staging window and append the report; this is follow-up evidence, not a prerequisite for the owner-waiver activation.
- Revoke or pause the waiver if staging shows policy bypass, scope leakage, PII exposure, duplicate external writes, or unexplained dual-write divergence.

## Reviewer handoff

`@claude` should review this exception as a roadmap and Gate-policy change. The intended interpretation is precise: **Phase 5 may proceed now by owner waiver; AC2 remains not verified; production enablement remains separately gated.**
