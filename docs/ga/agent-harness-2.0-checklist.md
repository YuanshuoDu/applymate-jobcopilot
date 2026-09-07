# Agent Harness 2.0 GA checklist

This is the 30-item sign-off sheet for AH2-052. It is reconciled against
`origin/master` commit `dae489d` on 2026-09-07. The checklist deliberately
separates repository evidence from staging/production evidence:

- `PASS` means the implementation or CI evidence is immutable and linked.
- `WAIVED / NOT VERIFIED` means the owner allowed progression, but no empirical
  result is being claimed.
- `PENDING` means a staging, production, rollback, or owner sign-off artifact
  is still required.

An item marked `WAIVED / NOT VERIFIED` or `PENDING` is not a GA approval.

| # | Gate | Evidence reference | Status |
|---:|---|---|---|
| 1 | AH2-049 scripted contract suite is complete | [PR #483](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/483); Harness Contract CI on merge commit `c2bca5b` | ✅ PASS |
| 2 | Fault-injection matrix is 100% passing | [PR #483](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/483); deterministic crash matrix in `apps/worker/src/runtime/harness/scripted/crashes/` | ✅ PASS |
| 3 | Deterministic replay matches the recorded event stream | [PR #483](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/483); scripted replay/seed/trace tests | ✅ PASS |
| 4 | Duplicate external side effects are zero | [PR #483](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/483) ledger assertions; [PR #486](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/486) shadow guard | ✅ PASS |
| 5 | Trace IDs connect session, turn, step, tool, and submission | [PR #484](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/484), trace-context and trace-query tests | ✅ PASS |
| 6 | Usage is attributable by user, model, turn, and tool | [PR #484](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/484), usage aggregator and migration | ✅ PASS |
| 7 | Required SLO taxonomy is deployed | [PR #484](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/484), event types and SLO rules | ✅ PASS |
| 8 | SLO breach alert drill is successful | [PR #484](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/484), successful Harness Observability Drill CI | ✅ PASS |
| 9 | Admin observability routes enforce RBAC | [PR #484](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/484), admin observability route tests | ✅ PASS |
| 10 | Observability payloads contain no PII | [PR #484](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/484), PII-negative event tests | ✅ PASS |
| 11 | Shadow comparator runs V1 advisory and V2 authority | [PR #486](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/486), `apps/worker/src/runtime/rollout/shadow.ts` | ✅ PASS |
| 12 | V1 shadow path cannot perform an external action | [PR #486](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/486), `double_execution_blocked` tests | ✅ PASS |
| 13 | Internal-only observation window is complete | No immutable staging observation report is present | ⏳ PENDING |
| 14 | Staging 1% observation window is complete | No signed staging canary report is present | ⏳ PENDING |
| 15 | Staging 5% observation window is complete | No signed staging canary report is present | ⏳ PENDING |
| 16 | Staging 25% observation window is complete | No signed staging canary report is present | ⏳ PENDING |
| 17 | Staging 50% observation window is complete | No signed staging canary report is present | ⏳ PENDING |
| 18 | Staging 100% observation window is complete | No signed staging canary report is present | ⏳ PENDING |
| 19 | Completion rate meets the 99% threshold | Requires real rollout metrics, not CI | ⏳ PENDING |
| 20 | Unauthorized external actions remain zero | Requires staging/production rollout report | ⏳ PENDING |
| 21 | Duplicate submissions remain zero | Requires staging/production rollout report | ⏳ PENDING |
| 22 | Replay consistency meets 99.9% | Requires real rollout metrics | ⏳ PENDING |
| 23 | Cost p95 is at most 1.2x the legacy baseline | Requires real usage baseline and rollout report | ⏳ PENDING |
| 24 | Every stage has a signed go/no-go report | No signed report set is present | ⏳ PENDING |
| 25 | Automatic rollback drill is successful | Code path exists in [PR #486](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/486); real rollback drill is not evidenced | ⏳ PENDING |
| 26 | V1 traffic is zero for seven consecutive days | Owner waiver permits progression; no seven-day production measurement is claimed | ⚠️ WAIVED / NOT VERIFIED |
| 27 | Archive access is read-only and ownership-scoped | [PR #487](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/487), archive route and ownership tests | ✅ PASS |
| 28 | Emergency adapter is fail-closed by default | [PR #487](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/487), `EMERGENCY_LEGACY_MODE` tests | ✅ PASS |
| 29 | Legacy deletion and destructive migration are separated | [PR #487](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/487) and [PR #489](https://github.com/YuanshuoDu/applymate-jobcopilot/pull/489) | ✅ PASS |
| 30 | On-call, security, escalation, and maintenance contracts are signed | Runbook and maintenance contract exist; owner sign-off is not recorded | ⏳ PENDING OWNER SIGN-OFF |

## Related operational gates

The Phase 4 48-hour dual-write window is explicitly recorded as
`WAIVED / NOT VERIFIED` in
[`dual-write-48h.md`](../agent-harness-v2/gates/phase-4/dual-write-48h.md).
The real staging approval smoke and SSE evidence remain tracked in
[Issue #387](https://github.com/YuanshuoDu/applymate-jobcopilot/issues/387).
The SSE drill artifact records a 32-second disconnect and a lossless cursor
reconnect, but it does not replace the missing rollout and production evidence.

## Sign-off rule

AH2-052 cannot be marked GA while any item is `PENDING` or
`WAIVED / NOT VERIFIED`. A green CI run proves repository behavior only; it
does not prove staging/production observation, rollback, zero legacy traffic,
or owner sign-off. The final GA report must replace each pending row with an
immutable deployment, query, screenshot, trace, signed report, or owner
approval reference before the Initiative can close.
