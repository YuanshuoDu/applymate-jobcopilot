# V1 Agent-state inventory

Status: **staging-rehearsal ready; production destructive cleanup blocked**

Owner: YuanshuoDu (engineering/product owner)

This inventory is deliberately limited to the Agent state that was created
before the Harness 2.0 turn/event model. It does not classify unrelated
candidate, billing, Gmail, or admin tables as disposable merely because they
predate AH2. The `KEEP` entries are part of the current job-application
product and must not be removed by this migration.

## Evidence and limitations

The repository does not contain production row counts or durable last-write
telemetry. A production or staging operator must run the read-only query in
`rehearse-v1-cleanup.sh` against an approved dump/database and attach the
result to the rehearsal report. No prompt, resume, email, credential, or job
content is copied into the report.

The repository also contains no `CREATE SEQUENCE` or `nextval()` for the
Agent state. `AgentSession.eventSequence` and `AgentEvent.sequence` are
ordinary `BIGINT` values allocated/validated by application transactions,
not PostgreSQL sequences.

## Decision table

| Object | Columns / indexes / sequence | Current repository evidence | Row count / last write | Retention obligation | Recommendation |
|---|---|---|---|---|---|
| `agent_runs` | `id`, `userId`, `status`, `durationMs`, `stagesCompleted`, `jobsFound`, `report`, `log`, `createdAt`, `updatedAt`; `agent_runs_userId_createdAt_idx`; no sequence | `apps/web/src/lib/agent/run-service.ts` writes it; history and archive routes read it | Operator report required | Historical run visibility and user deletion policy | **KEEP now; archive later** |
| `AgentRunQuestion` | `id`, `userId`, `runId`, `stage`, `question`, `options`, `answer`, `autonomous`, `createdAt`, `answeredAt`; `AgentRunQuestion_userId_runId_idx` | Orchestrator, answer route, session detail, and persona export still use it | Operator report required; physical migration provenance is incomplete | Pending user answers and export/delete obligations | **KEEP table; DROP only unused `...answeredAt...` index** |
| `agent_executions` | Control state, checkpoint, worker task, attempts, timestamps; unique `sessionId` and two status indexes | `execution-control.ts`, execution API, automation routes, and worker queue still use it | Operator report required | Resumability, cancellation, audit, and user deletion policy | **KEEP now; archive later** |
| `agent_transcript_events` | Transcript fields, session/type indexes | Legacy SSE/history fallback and V2 projection still use it | Operator report required | Candidate transcript retention and erasure policy | **KEEP now; archive later** |
| `application_tasks` / `application_task_events` | Application lifecycle, confirmed answers, worker task and event history; three task indexes | Worker application state and admin/application APIs still read/write it | Operator report required | Application records and sensitive-answer retention | **KEEP** |
| `form_patterns` | User-scoped ATS pattern fields; unique user/host/pattern key | Worker apply queue replays and records patterns | Operator report required | User-scoped application automation data | **KEEP** |
| `agent_sessions` | Session root, status, summary, cursor, `eventSequence`; session indexes | Root of V2 turns, tasks, events, approvals and UI replay | Operator report required | Canonical conversation retention | **KEEP** |
| `agent_turns`, `agent_steps`, `agent_inputs`, `agent_items` | Turn/step/input/item state and uniqueness constraints | V2 TurnEngine, recovery, timeline and UI APIs | Operator report required | Replay and user deletion policy | **KEEP** |
| `agent_events`, `agent_outbox` | Durable event sequence/idempotency and dispatch records | V2 fact store, recovery scanner and publisher | Operator report required | Immutable audit/replay retention | **KEEP** |
| `sub_agent_tasks`, `agent_mailbox_messages` | Task tree and inter-agent delivery state | Subagent manager, task API, mailbox and worker runtime | Operator report required | Agent execution/audit retention | **KEEP** |
| `agent_approvals`, `agent_action_reservations` | Scoped approval, nonce, resource hash and single-use reservation | Web/Worker policy and external-action paths | Operator report required | Approval/audit retention | **KEEP** |

## Approved object for this PR

`AgentRunQuestion_userId_runId_answeredAt_idx` is the only approved DROP
object. A repository-wide search found no query that filters or orders by
`answeredAt`; the active answer/session queries use `{ userId, runId,
answer: null }`, which is covered by the retained
`AgentRunQuestion_userId_runId_idx`. The migration uses `IF EXISTS` because
this index is absent from the checked-in migration history even though the
Prisma model declares it; this makes the cleanup safe across production
databases created by different historical paths.

No table, column, row, foreign key, or PostgreSQL sequence is approved for
DROP. The migration must be stopped and reviewed if a proposed change adds
any other object.

## Operator evidence query

Run against a disposable restore or an approved read-only connection. This
returns metadata only:

```sql
WITH target_tables(relname) AS (
  VALUES
    ('agent_runs'), ('AgentRunQuestion'), ('agent_executions'),
    ('agent_transcript_events'), ('application_tasks'),
    ('application_task_events'), ('form_patterns'), ('agent_sessions'),
    ('agent_turns'), ('agent_steps'), ('agent_inputs'), ('agent_items'),
    ('agent_events'), ('agent_outbox'), ('sub_agent_tasks'),
    ('agent_mailbox_messages'), ('agent_approvals'),
    ('agent_action_reservations')
), objects AS (
  SELECT 'table' AS kind, c.relname AS name, c.oid
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN target_tables t ON t.relname = c.relname
  WHERE n.nspname = 'public' AND c.relkind = 'r'
  UNION ALL
  SELECT 'index', i.relname, i.oid
  FROM pg_class i
  JOIN pg_namespace n ON n.oid = i.relnamespace
  JOIN pg_index ix ON ix.indexrelid = i.oid
  JOIN pg_class t ON t.oid = ix.indrelid
  JOIN pg_namespace tn ON tn.oid = t.relnamespace
  JOIN target_tables wanted ON wanted.relname = t.relname
  WHERE n.nspname = 'public' AND tn.nspname = 'public'
  UNION ALL
  SELECT 'sequence', c.relname, c.oid
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'S'
)
SELECT kind, name, to_regclass(oid::regclass::text) AS regclass
FROM objects
ORDER BY kind, name;
```

Row counts and last-write values are collected by the rehearsal script from
the restored database and are not guessed in source control.
