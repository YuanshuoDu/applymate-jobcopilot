# Phase 4 Exit Report — Requested Phase 5 Decision

**Report status:** Draft for Claude/PM §1.8 review; #387 and Phase 5 activation remain blocked until the PM decision is recorded.

**Report date:** 2026-10-01

**Requested decision:** GO by owner waiver for Phase 5 implementation only

**Evidence-complete Phase 4 status:** Not claimed (`accepted_by_owner_waiver`, not `completed`)

## Scope

- **Issues completed:** AH2-018–021 (#376–#379); implementation and code-level controls were reviewed in merged PRs #382–#385.
- **Evidence/runbook PRs:** #389 and #390; staging trace PR #392; audit-chain repair PR #519 is a related operational repair, not evidence that Phase 4 staging checks passed.
- **Feature flags and current values:** Not freshly read for this report. The 2026-09-01 values in `dual-write-48h.md` are historical only; the 2026-09-05 staging readback reported the control-plane/database binding unresolved. Do not rely on historical values as current.
- **Migrations deployed:** PR #519's additive audit-chain migration is merged. Its application and post-deployment health/checkpoint readback are not independently verified here. No migration or flag change was performed for this gate decision.

## Goal result

- **Planned outcome:** Verify the Phase 4 policy, approval, resume, and redaction controls, then decide whether Phase 5 implementation may proceed.
- **Actual outcome:** Code-level policy, scope/expiry/race rejection, broker wakeup, and allow-list redaction changes are merged. The owner approved the two named waivers below; the latest issue ruling still requires Claude/PM to record the §1.8 decision before Phase 5 is unblocked.
- **Partial/unverified items:**
  - V3 staging approval/decline/expiry browser smoke: **WAIVED / NOT VERIFIED** by the [owner decision](https://github.com/YuanshuoDu/applymate-jobcopilot/issues/387#issuecomment-5931612168). It was not run for this decision and is not a PASS.
  - V5 48-hour dual-write integrity report: **WAIVED / NOT VERIFIED** by the same decision. No empirical 48-hour counts or parity result are claimed.
  - SSE disconnect/reconnect replay: **OBSERVED / ACCEPTED for the named route-replay requirement**. The attached [PR #392 trace](https://github.com/YuanshuoDu/applymate-jobcopilot/blob/d3de94f/docs/agent-harness-v2/gates/phase-4/sse-drill.trace.jsonl) records a real authenticated staging Preview route, a 32-second disconnect, durable sequence 6 inserted during the disconnect, resume after sequence 5, returned sequence `[6]`, zero duplicates, and zero missed durable events. The event was synthetic/operator-inserted; no Worker/Redis automation ran. The owner ruled that this meets the #387 SSE replay item and said not to rerun it ([ruling](https://github.com/YuanshuoDu/applymate-jobcopilot/issues/387#issuecomment-5929863153)).
  - Worker-produced event publication and original-Turn wake/resume have no new end-to-end staging evidence in the SSE trace. Existing code-level review remains in PR #384; the runtime gap is retained as unverified rather than inferred from route replay. The 2026-10-01 owner waiver explicitly names the staging approval/decline/expiry browser smoke; this report does not assume it separately waives this original-Turn runtime item. PM must classify it before deciding GO/NO-GO.
  - Staging control-plane/database/deployment binding and post-#519 audit migration/checkpoint health remain unverified; neither production rollout nor flag activation is authorized by this decision.

## Verification

- **V1 unit/contract:** Code-level approval, policy, and redaction evidence is in merged PRs #382–#385. No new tests were run for this documentation-only reconciliation.
- **V2 integration/fault:** Merged PR checks cover code-level approval and broker contracts; this report does not claim a new full staging approval-to-resume run.
- **V3 CI/staging:** PR #392 contains the accepted 32-second staging Preview SSE replay. Approval/decline/expiry staging smoke is waived and not verified.
- **V4 browser/manual:** The SSE trace was obtained from an authenticated staging Preview; approval browser rehearsal was waived and not run for this decision.
- **V5 production observation:** No production observation or audit-checkpoint write/read was performed as part of this report. Production rollout stays separately gated.

## Gate metrics

- **Correctness:** SSE route replay observed 0 duplicate and 0 missed durable events for the recorded single synthetic event; 48-hour dual-write correctness remains unmeasured.
- **Security/authorization:** Code-level policy, scoped receipt, expiry/race checks, and redaction passed review in #382–#385; full staging approval-path smoke remains waived/not verified.
- **Replay/recovery:** Cursor replay is observed as above. Worker-originated event delivery and wake of the original Turn remain unverified at runtime.
- **Latency/cost:** No Phase 4 latency or cost measurement was produced for this gate decision.
- **Tenant/PII:** Code-level redaction/ownership evidence is in the merged Phase 4 PRs; the waived browser smoke supplies no additional runtime measurement.

## Rollback

- **Rehearsal result:** No rollback rehearsal was run for this documentation-only Phase 5 implementation activation. This decision performs no deployment, feature-flag write, or production activation.
- **Rollback trigger:** Any policy bypass, scope leakage, PII/secret exposure, duplicate external write, unexplained dual-write divergence, or loss of durable SSE replay requires stopping the affected staging rollout and reverting/pausing the relevant feature path under the reviewed operational runbook.
- **Owner:** Product owner and the separately authorized staging/production operator; no production rollback authority is granted by this report.

## Decision

- **GO / NO-GO:** **PENDING Claude/PM decision.** Requested disposition: GO by owner waiver for Phase 5 implementation only, if PM accepts the unverified original-Turn runtime item under the named approval-smoke waiver. Otherwise keep #387 blocked and specify the smallest follow-up evidence. Do not mark Phase 4 `completed`; approval smoke and the 48-hour report remain `WAIVED / NOT VERIFIED`; production rollout remains NO-GO pending its own evidence and approval.
- **Reviewer:** Claude/PM must review this report against roadmap §1.8 and record the final #387 disposition.
- **Next Phase activation date:** TBD; only after Claude/PM records GO in #387. The prior owner waiver remains the decision basis, but Phase 5's own Exit Gate remains mandatory.
