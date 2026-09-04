# Agent Harness 2.0 GA checklist

This is the 30-item sign-off sheet for AH2-052. It is intentionally created
before the final gate closes. An unchecked item is a release blocker; a green
CI run is not production evidence. Each checked item must include a commit,
deployment, query, screenshot, or signed report reference.

| # | Gate | Evidence reference | Status |
|---:|---|---|---|
| 1 | AH2-049 scripted contract suite is complete | Pending final gate | [ ] |
| 2 | Fault-injection matrix is 100% passing | Pending final gate | [ ] |
| 3 | Deterministic replay matches the recorded event stream | Pending final gate | [ ] |
| 4 | Duplicate external side effects are zero | Pending final gate | [ ] |
| 5 | Trace IDs connect session, turn, step, tool, and submission | Pending final gate | [ ] |
| 6 | Usage is attributable by user, model, turn, and tool | Pending final gate | [ ] |
| 7 | Required SLO taxonomy is deployed | Pending final gate | [ ] |
| 8 | SLO breach alert drill is successful | Pending final gate | [ ] |
| 9 | Admin observability routes enforce RBAC | Pending final gate | [ ] |
| 10 | Observability payloads contain no PII | Pending final gate | [ ] |
| 11 | Shadow comparator runs V1 advisory and V2 authority | Pending final gate | [ ] |
| 12 | V1 shadow path cannot perform an external action | Pending final gate | [ ] |
| 13 | Internal-only observation window is complete | Pending staging evidence | [ ] |
| 14 | Staging 1% observation window is complete | Pending staging evidence | [ ] |
| 15 | Staging 5% observation window is complete | Pending staging evidence | [ ] |
| 16 | Staging 25% observation window is complete | Pending staging evidence | [ ] |
| 17 | Staging 50% observation window is complete | Pending staging evidence | [ ] |
| 18 | Staging 100% observation window is complete | Pending staging evidence | [ ] |
| 19 | Completion rate meets the 99% threshold | Pending rollout report | [ ] |
| 20 | Unauthorized external actions remain zero | Pending rollout report | [ ] |
| 21 | Duplicate submissions remain zero | Pending rollout report | [ ] |
| 22 | Replay consistency meets 99.9% | Pending rollout report | [ ] |
| 23 | Cost p95 is at most 1.2x the legacy baseline | Pending rollout report | [ ] |
| 24 | Every stage has a signed go/no-go report | Pending rollout reports | [ ] |
| 25 | Automatic rollback drill is successful | Pending rollback evidence | [ ] |
| 26 | V1 traffic is zero for seven consecutive days | Pending production query plus deployment logs | [ ] |
| 27 | Archive access is read-only and ownership-scoped | Pending route evidence | [ ] |
| 28 | Emergency adapter is fail-closed by default | Pending adapter tests | [ ] |
| 29 | Legacy deletion and destructive migration are separated | Pending issue/PR links | [ ] |
| 30 | On-call, security, escalation, and maintenance contracts are signed | Pending owner sign-off | [ ] |

## Sign-off rule

AH2-052 cannot be marked GA while any item is unchecked. The checklist must
be updated with immutable evidence references after each gate; do not mark an
item complete based on an assumption, a local-only test, or a preview deploy.
