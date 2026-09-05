# V1 cleanup → V2 impact matrix

Status: **review complete for the index-only cleanup; table cleanup is not
approved**

The central safety conclusion is that current V2 is not independent of every
historical Agent table yet. This matrix prevents the migration from deleting
an object merely because its name contains `legacy`.

| V1 object | V2 path / consumer | Evidence that the approved cleanup does not affect it | Decision |
|---|---|---|---|
| `agent_runs` | `apps/web/src/lib/agent/run-service.ts`; `/api/agent/history`; `/api/agent/run/[id]/archive` | The migration does not touch the table or its columns. Archive remains an ownership-scoped read of bounded fields. | KEEP |
| `AgentRunQuestion` | `apps/web/src/lib/agent/orchestrator.ts`; `/api/agent/answer`; `/api/agent/sessions/[id]` | The answer/session predicates use `userId`, `runId`, and `answer`; no code filters/orders by `answeredAt`. The retained two-column index continues to cover the lookup prefix. | KEEP table; remove unused index |
| `agent_executions` | `apps/web/src/lib/agent/execution-control.ts`; executions/automation routes; Worker run queue | The migration does not touch the control table, checkpoint fields, or indexes. | KEEP |
| `agent_transcript_events` | session event fallback, chat history, transcript projector | The migration does not touch transcript state or its indexes. | KEEP |
| `application_tasks` | Worker `application-task-state.ts`; admin/application APIs | The migration does not touch application task state or confirmed answers. | KEEP |
| `form_patterns` | Worker apply queue replay/writeback | The migration does not touch user-scoped pattern data or its unique key. | KEEP |
| `agent_sessions` | V2 root session, session UI, automation reuse | The migration does not touch the root session, cursor, or event sequence. | KEEP |
| `agent_turns` / `agent_steps` / `agent_inputs` / `agent_items` | Turn lease, timeline, context and input consumption | The migration does not touch V2 turn graph tables or their uniqueness constraints. | KEEP |
| `agent_events` / `agent_outbox` | Replay, idempotency and worker wakeup | The migration does not touch facts, sequence allocation, or outbox dispatch. | KEEP |
| `sub_agent_tasks` / `agent_mailbox_messages` | Task tree and subagent coordination | The migration does not touch task/mailbox state. | KEEP |
| `agent_approvals` / `agent_action_reservations` | Policy broker and external-action executor | The migration does not touch approval receipts, nonce hashes, or reservations. | KEEP |

## Verification commands

The following checks are intentionally source-level and contain no candidate
data:

```bash
rg -n "answeredAt|answered_at" apps/web/src apps/worker/src packages
rg -n "AgentRunQuestion_userId_runId_answeredAt_idx" apps/web/src apps/worker/src packages
rg -n "@prisma/client" apps/worker/package.json
```

The first command should show writes/DTO exports but no query predicate or
ordering that requires the removed index. The second should show only schema
history/inventory references. The third must return no match.

## What remains blocked

`agent_runs`, `AgentRunQuestion`, `agent_executions`, and transcript state
cannot be physically removed until the old readers/writers are retired,
archive/reporting projection is proven, durable seven-day traffic evidence is
attached, and the GA owner signs off. That work is separate from this
index-only migration and must not be smuggled into it.
