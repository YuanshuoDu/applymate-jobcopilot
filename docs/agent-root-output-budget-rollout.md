# Agent root output-token budget rollout

This runbook covers the mixed-version boundary for the root output-token reservation ledger. It describes deployment requirements; it does not mean a production rollout has been performed.

## Optional server-owned Root limit

The Web and Worker services may set `AGENT_ROOT_MAX_OUTPUT_TOKENS` to a non-negative decimal integer no greater than `2147483647`. Every serving instance of both services must use the same value when the limit is enabled; a stale or differently configured instance can create a Turn with a different immutable snapshot. An absent setting stores the existing empty budget snapshot and adds no default. An empty, signed, fractional, exponent-form, or out-of-range value rejects new Turn creation before its Turn or dispatch outbox entry is committed. The value is server-owned; request content, client fields, and model output cannot override it. A value of `0` is valid and leaves no output capacity, so a provider call cannot be admitted.

Every current execution-Turn creation path reads that setting only when it creates a new Turn:

- `commands/transaction.ts:createRootTurn` covers command-started Root Turns, including objective and selected-job preparation.
- `session/v2-turn.ts:ensureV2TurnInTransaction` covers compatibility/API Turns created after the session has no active Turn.
- `automation-session.ts:ensureAutomationTurn` covers newly queued manual and scheduled automation Turns.
- `turn-engine-terminal-commit.ts:promoteFollowUp` covers a newly queued successor Turn when an accepted follow-up must move off a completed Turn. It reads the Worker server setting inside the same fenced completion transaction before any terminal writes; an invalid setting rolls the transaction back.
- `agent-fork-service.ts` copies old Turns only as non-executing history, with no Root link, lease, or dispatch; those copies remain unchanged. A fork edit creates a separate executing Turn through `createRootTurn` and receives the current setting.

Reusing an active Turn leaves its persisted snapshot unchanged. A retry reads the failed predecessor's whole `budgetSnapshot` under the existing owner/session/Turn query and copies it to the successor, even if the Web setting changed or is now invalid. The Worker-promoted follow-up is a new Turn and reads its current server setting; it does not inherit the completed Turn's consumed budget. Historical Turns are not backfilled or rewritten. The Worker copies a newly created Turn's snapshot to its Root Task; the existing v1 reservation protocol then shares that Root capacity across Root and child provider calls. Nested Scout admission remains fail-closed until a real disposable Worker-to-Web shared-budget witness passes.

## Compatibility matrix

| Web/server | Worker | Root budget | Behavior |
|---|---|---|---|
| New | Old protocol (v0) | No `maxOutputTokens` limit | The legacy request and settlement path remains available. It does not create a v1 reservation or receive start fencing. |
| New | Old protocol (v0) | Strict output limit | Admission fails closed with `usage_start_protocol_required`, before provider invocation. |
| New | V1 | Root marker is missing | A strict output limit fails closed with `root_usage_unmarked`. Existing roots are not backfilled automatically. |
| New | V1 | Root is marked v1 | Admission reserves the remaining output allowance. The Worker must persist a successful start claim before invoking the provider and pass the returned cap. |
| Old | New v1 | Any | The Worker requires a v1 authorization response and a successful start response. A missing or incompatible response is rejected before provider invocation; authorization is released where the endpoint permits it. |

Old Workers do not have provider-start fencing. Keep strict output limits off any Root they can execute. New Workers must not be pointed at an old server and treated as ready: their protocol checks intentionally fail closed.

## Rollout order

1. **Prepare the runtime database role.** Before applying the migration, create or verify `applymate_candidate` as a non-login role without superuser or `BYPASSRLS` privileges. Verify its schema usage and required runtime grants. The migration grants privileges conditionally when this role already exists; it does not create the role.
2. **Apply and verify the migration.** Confirm the migration is recorded as applied, the ledger table and usage-event protocol columns exist, row-level security is enabled, and `applymate_candidate` has only the intended table and column privileges.
3. **Deploy the Web/server code.** The production Vercel build runs `prisma migrate deploy` before generating Prisma Client and building the new app. The runtime role prerequisites above must be met before that build reaches the migration.
4. **Deploy the v1 Worker code.** Wait for every serving Worker to run code that sends protocol v1, claims start before provider invocation, enforces the returned output cap, and reports unknown usage as unknown.
5. **Drain old Workers and their in-flight work.** Do not introduce strict output-limited Roots while an old Worker can continue an attempt. Existing active Roots without `outputTokenReservationVersion = 1` remain unmarked and fail closed for strict admission.
6. **Opt new Roots into strict output limits.** Only after the server and all serving Workers support v1, configure `AGENT_ROOT_MAX_OUTPUT_TOKENS` to the same finite value on every Web and Worker instance. New Turns snapshot that value and new Root Tasks use `outputTokenReservationVersion = 1`. Monitor admission and settlement outcomes before widening use.

## Recovery and accounting boundaries

- Admission lazily examines at most 32 reservations for the active Root. It considers only v1 rows that are still reserved and whose usage event is reserved with no provider-start timestamp.
- A reservation is recovered only after its stored execution-owner lease no longer passes the current session, turn, task, and step fence. The event, reservation, and any identifiable monthly credit refund are handled in the same transaction.
- A started reservation is never automatically released. A provider may have been invoked, and its usage can still be unknown. Preserve unknown output and cost as `NULL`; do not convert them to zero or free catalog pricing.
- Legacy protocol-v0 events and old reservations are not guessed into the new ledger. Do not backfill ownership, start time, token usage, or credit-refund month from incomplete historical records.
- If an identifiable credit refund cannot be applied, reconciliation fails and the transaction preserves the reservation and usage event. Investigate the ledger state before manual repair.
- No TTL-based release is safe: time elapsed alone does not prove that a provider call did not start.

## Rollback

- Keep the migration and the compatible server code in place while v1 Workers or v1 reservations exist. Do not roll back the schema as part of a code rollback.
- Drain v1 Workers and let their started attempts settle before rolling the server back. Do not assume a reserved or started hold is safe to clear manually.
- An old Worker cannot claim the v1 start protocol. If it encounters a strict Root, the server rejects admission before provider invocation; the run may fail and require retry after compatible Workers return.
- Avoid running old Workers against active strict Roots. Root budget snapshots and opt-in markers are persisted, so changing a general setting does not make an already-created strict Root compatible with old code.
- If a rollback leaves a v1 reservation whose provider outcome is uncertain, retain it for investigation. Never delete or refund it solely because a deployment changed.

## Verification status

Coverage includes reservation fencing, start-versus-recovery serialization, tenant isolation, legacy preservation, and refund rollback. Require the dedicated disposable-PostgreSQL jobs to pass before release. Production role setup, migration execution, deployment, and database contents must also be verified in the target environment; none is performed by this runbook.
