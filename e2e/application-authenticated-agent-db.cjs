// Synthetic feature flag setup and assertions in the disposable database.
const { createRequire } = require('node:module')
const { randomUUID } = require('node:crypto')
const path = require('node:path')
const expectedDatabase = 'postgresql://fixture:fixture@db:5432/application_flow_fixture'
if (process.env.CI !== 'true' || process.env.APPLICATION_AUTH_DISPOSABLE !== 'true' ||
    process.env.APPLICATION_AUTH_AGENT_REVIEWED_EXECUTION !== 'true' ||
    process.env.DATABASE_URL !== expectedDatabase || process.env.DIRECT_URL !== expectedDatabase ||
    process.env.RLS_RUNTIME_MODE !== 'off' || process.env.PLATFORM_ENV !== 'development' ||
    process.env.REDIS_URL !== 'redis://redis:6379/15' ||
    process.env.AGENT_WEB_URL !== 'http://127.0.0.1:3100' ||
    process.env.AGENT_WORKER_SECRET !== 'fixture-only-worker-secret-at-least-32-bytes' ||
    process.env.AGENT_PREVIEW_FIXTURE) throw new Error('Not the reviewed disposable database')
const { Pool } = createRequire(path.resolve('apps/worker/package.json'))('pg')
const pool = new Pool({ connectionString: expectedDatabase, max: 2 })

async function initializeFixtureSse() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const database = await client.query('SELECT current_database() AS name')
    const users = await client.query('SELECT "id", "email" FROM "User" ORDER BY "email"')
    const empty = await client.query(`SELECT
      (SELECT COUNT(*)::int FROM "agent_sessions") AS sessions,
      (SELECT COUNT(*)::int FROM "agent_turns") AS turns,
      (SELECT COUNT(*)::int FROM "agent_items") AS items,
      (SELECT COUNT(*)::int FROM "agent_events") AS events,
      (SELECT COUNT(*)::int FROM "agent_outbox") AS outbox,
      (SELECT COUNT(*)::int FROM "PlatformFeatureFlag") AS flags`)
    if (database.rows[0]?.name !== 'application_flow_fixture' || users.rows.length !== 2 ||
        users.rows[0]?.email !== 'candidate-a@example.invalid' || users.rows[1]?.email !== 'candidate-b@example.invalid' ||
        Object.values(empty.rows[0]).some(count => count !== 0)) throw new Error('Expected empty disposable Agent state and fixture identities')
    const owner = users.rows[0].id
    await client.query(`INSERT INTO "PlatformFeatureFlag"
      ("id", "key", "environment", "enabled", "rolloutPercent", "targetPlans", "targetUserIds", "status", "version", "createdById", "updatedById", "createdAt", "updatedAt")
      VALUES ($1, 'AGENT_EVENT_SSE_V2', 'development', true, 0, ARRAY[]::"Plan"[], ARRAY[$2]::text[], 'active', 1, $2, $2, NOW(), NOW())`,
      [randomUUID(), owner])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

async function inspectTurn(sessionId, turnId) {
  const database = await pool.query('SELECT current_database() AS name')
  if (database.rows[0]?.name !== 'application_flow_fixture') throw new Error('Unexpected database')
  const result = await pool.query(`SELECT turn."id", turn."status", turn."revision", turn."finalResponse", turn."error",
    session."userId" AS "sessionOwner", turn."userId" AS "turnOwner", candidate."email",
    (SELECT COUNT(*)::int FROM "agent_events" AS event WHERE event."sessionId" = session."id" AND event."turnId" = turn."id" AND event."type" = 'turn.completed') AS "completedEvents",
    (SELECT COUNT(*)::int FROM "agent_events" AS event WHERE event."sessionId" = session."id" AND event."turnId" = turn."id" AND event."type" = 'question.answered') AS "answeredEvents"
    FROM "agent_turns" AS turn JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
    JOIN "User" AS candidate ON candidate."id" = session."userId"
    WHERE session."id" = $1 AND turn."id" = $2`, [sessionId, turnId])
  const row = result.rows[0]
  if (result.rowCount !== 1 || row.email !== 'candidate-a@example.invalid' || row.turnOwner !== row.sessionOwner) {
    throw new Error('Unexpected session or turn owner')
  }
  const items = await pool.query(`SELECT "id", "status", "content" FROM "agent_items"
    WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'question'`, [sessionId, turnId])
  const events = await pool.query(`SELECT "type" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 ORDER BY "sequence"`, [sessionId, turnId])
  const steps = await pool.query(`SELECT "status", "errorCode", "finishReason" FROM "agent_steps" WHERE "sessionId" = $1 AND "turnId" = $2 ORDER BY "ordinal", "attempt"`, [sessionId, turnId])
  const tasks = await pool.query(`SELECT "status", "failureReason" FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "turnId" = $2 ORDER BY "createdAt"`, [sessionId, turnId])
  const toolResults = await pool.query(`SELECT COUNT(*)::int AS count,
    BOOL_OR("content"->'output'->>'question' = '[REDACTED]') AS "questionRedacted"
    FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'tool_result'
      AND "content"->>'toolCallId' = 'fixture-native-question'`, [sessionId, turnId])
  const wakeupOutbox = await pool.query(`SELECT COUNT(*)::int AS count,
    COUNT(*) FILTER (WHERE outbox."publishedAt" IS NOT NULL)::int AS "publishedCount",
    COALESCE(MAX(outbox."attemptCount"), 0)::int AS "maxAttemptCount"
    FROM "agent_events" AS event
    JOIN "agent_outbox" AS outbox ON outbox."idempotencyKey" = 'agent-event:' || event."id"
      AND outbox."topic" = 'agent.turn.wakeup' AND outbox."aggregateId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = 'turn.wakeup'`, [sessionId, turnId])
  const turnDispatchOutbox = await pool.query(`SELECT COUNT(*)::int AS count,
    COUNT(*) FILTER (WHERE outbox."publishedAt" IS NOT NULL)::int AS "publishedCount",
    COALESCE(MAX(outbox."attemptCount"), 0)::int AS "maxAttemptCount",
    CASE
      WHEN BOOL_OR(outbox."lastError" = 'queue_add_failed') THEN 'queue_add_failed'
      WHEN BOOL_OR(outbox."lastError" = 'turn_dispatch_lineage_mismatch') THEN 'turn_dispatch_lineage_mismatch'
      WHEN BOOL_OR(outbox."lastError" = 'schema_invalid_payload') THEN 'schema_invalid_payload'
      WHEN BOOL_OR(outbox."lastError" IS NOT NULL) THEN 'other'
      ELSE 'none'
    END AS "lastErrorCategory"
    FROM "agent_outbox" AS outbox
    WHERE outbox."topic" = 'agent.turn.dispatch' AND outbox."aggregateId" = $1
      AND outbox."idempotencyKey" = 'turn-dispatch:' || $2
      AND outbox."payload"->>'sessionId' = $1 AND outbox."payload"->>'turnId' = $2`, [sessionId, turnId])
  const turnDlq = await pool.query(`SELECT COUNT(*)::int AS count,
    COALESCE(MAX(CASE WHEN outbox."payload"->>'attemptsMade' ~ '^[0-9]{1,6}$'
      THEN LEAST((outbox."payload"->>'attemptsMade')::int, 1000) ELSE 0 END), 0)::int AS "maxAttemptCount",
    COUNT(*) FILTER (WHERE outbox."payload"->>'reason_code' = 'schema_invalid_payload')::int AS "reasonSchemaInvalidPayload",
    COUNT(*) FILTER (WHERE outbox."payload"->>'reason_code' = 'max_retries_exhausted')::int AS "reasonMaxRetriesExhausted",
    COUNT(*) FILTER (WHERE outbox."payload"->>'reason_code' = 'execution_failed')::int AS "reasonExecutionFailed",
    COUNT(*) FILTER (WHERE outbox."payload"->>'reason_code' = 'lease_lost')::int AS "reasonLeaseLost",
    COUNT(*) FILTER (WHERE outbox."payload"->>'reason_code' = 'cognitive_agenda_resume_fence_invalid')::int AS "reasonResumeFenceInvalid",
    COUNT(*) FILTER (WHERE COALESCE(outbox."payload"->>'reason_code', '') NOT IN
      ('schema_invalid_payload', 'max_retries_exhausted', 'execution_failed', 'lease_lost', 'cognitive_agenda_resume_fence_invalid'))::int AS "reasonOther",
    COUNT(*) FILTER (WHERE outbox."payload"->>'error_code' = 'invalid_payload')::int AS "errorInvalidPayload",
    COUNT(*) FILTER (WHERE outbox."payload"->>'error_code' = 'turn_execution_error')::int AS "errorTurnExecution",
    COUNT(*) FILTER (WHERE outbox."payload"->>'error_code' = 'lease_not_available')::int AS "errorLeaseNotAvailable",
    COUNT(*) FILTER (WHERE outbox."payload"->>'error_code' = 'lease_lost')::int AS "errorLeaseLost",
    COUNT(*) FILTER (WHERE outbox."payload"->>'error_code' = 'cognitive_agenda_resume_fence_invalid')::int AS "errorResumeFenceInvalid",
    COUNT(*) FILTER (WHERE COALESCE(outbox."payload"->>'error_code', '') NOT IN
      ('invalid_payload', 'turn_execution_error', 'lease_not_available', 'lease_lost', 'cognitive_agenda_resume_fence_invalid'))::int AS "errorOther"
    FROM "agent_outbox" AS outbox
    WHERE outbox."topic" = 'agent.turn.dlq' AND outbox."aggregateId" = $2
      AND outbox."payload"->>'sessionId' = $1 AND outbox."payload"->>'turnId' = $2`, [sessionId, turnId])
  return { turn: row, questions: items.rows, eventTypes: events.rows.map(event => event.type), steps: steps.rows, tasks: tasks.rows,
    toolResultCount: toolResults.rows[0].count, toolResultQuestionRedacted: toolResults.rows[0].questionRedacted,
    wakeupOutbox: wakeupOutbox.rows[0], turnDispatchOutbox: turnDispatchOutbox.rows[0], turnDlq: turnDlq.rows[0] }
}

const MAX_DIAGNOSTIC_COUNT = 1000
const TURN_DIAGNOSTIC_STATUSES = ['queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user', 'interrupted', 'cancelled', 'failed', 'completed']
const ITEM_DIAGNOSTIC_STATUSES = ['queued', 'started', 'streaming', 'waiting_for_tool', 'waiting_for_approval', 'waiting_for_user', 'completed', 'failed', 'interrupted', 'cancelled']
const STEP_DIAGNOSTIC_STATUSES = ['queued', 'streaming', 'waiting_for_tool', 'waiting_for_approval', 'waiting_for_user', 'completed', 'failed', 'interrupted']
const TASK_DIAGNOSTIC_STATUSES = ['queued', 'running', 'waiting', 'waiting_for_user', 'completed', 'failed', 'interrupted', 'cancelled', 'closed', 'passed', 'retrying', 'skipped']
const EVENT_DIAGNOSTIC_LABELS = {
  'turn.wakeup': 'turnWakeup', 'turn.resumed': 'turnResumed', 'turn.completed': 'turnCompleted',
  'turn.failed': 'turnFailed', 'question.answered': 'questionAnswered', 'item.completed': 'itemCompleted', 'item.failed': 'itemFailed',
}

async function inspectFinalVisibility(sessionId, turnId, timelineHttpCategory) {
  const turnResult = await pool.query('SELECT turn."status", (turn."finalResponse" IS NOT NULL AND length(BTRIM(turn."finalResponse")) > 0) AS "finalResponsePresent" FROM "agent_turns" AS turn WHERE turn."sessionId" = $1 AND turn."id" = $2', [sessionId, turnId])
  if (turnResult.rowCount !== 1) return { stateAvailable: false, timelineHttpCategory: safeTimelineHttpCategory(timelineHttpCategory) }
  const [items, events, steps, tasks] = await Promise.all([
    pool.query('SELECT "status", COUNT(*)::int AS "count" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = \'agent_message\' AND "phase" = \'final_answer\' GROUP BY "status"', [sessionId, turnId]),
    pool.query('SELECT "type", COUNT(*)::int AS "count" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 GROUP BY "type"', [sessionId, turnId]),
    pool.query('SELECT "status", COUNT(*)::int AS "count" FROM "agent_steps" WHERE "sessionId" = $1 AND "turnId" = $2 GROUP BY "status"', [sessionId, turnId]),
    pool.query('SELECT "status", COUNT(*)::int AS "count" FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "turnId" = $2 GROUP BY "status"', [sessionId, turnId]),
  ])
  const eventCounts = Object.fromEntries([...Object.values(EVENT_DIAGNOSTIC_LABELS), 'other'].map(label => [label, 0]))
  for (const row of events.rows) {
    const label = typeof row.type === 'string' && Object.prototype.hasOwnProperty.call(EVENT_DIAGNOSTIC_LABELS, row.type) ? EVENT_DIAGNOSTIC_LABELS[row.type] : 'other'
    eventCounts[label] = Math.min(MAX_DIAGNOSTIC_COUNT, eventCounts[label] + boundedCount(row.count))
  }
  const turn = turnResult.rows[0]
  return {
    stateAvailable: true,
    timelineHttpCategory: safeTimelineHttpCategory(timelineHttpCategory),
    turnStatus: safeStatus(turn.status, TURN_DIAGNOSTIC_STATUSES),
    finalResponsePresent: turn.finalResponsePresent === true,
    finalItemStatusCounts: boundedStatusCounts(items.rows, ITEM_DIAGNOSTIC_STATUSES),
    eventCounts,
    stepStatusCounts: boundedStatusCounts(steps.rows, STEP_DIAGNOSTIC_STATUSES),
    taskStatusCounts: boundedStatusCounts(tasks.rows, TASK_DIAGNOSTIC_STATUSES),
  }
}

function boundedStatusCounts(rows, allowed) {
  const counts = Object.fromEntries([...allowed, 'other'].map(status => [status, 0]))
  for (const row of rows) {
    const status = safeStatus(row.status, allowed)
    counts[status] = Math.min(MAX_DIAGNOSTIC_COUNT, counts[status] + boundedCount(row.count))
  }
  return counts
}

function safeStatus(value, allowed) { return typeof value === 'string' && allowed.includes(value) ? value : 'other' }
function boundedCount(value) { return Number.isSafeInteger(value) && value > 0 ? Math.min(value, MAX_DIAGNOSTIC_COUNT) : 0 }
function safeTimelineHttpCategory(value) {
  return ['ok', 'unauthorized', 'not_found', 'rate_limited', 'server_error', 'other', 'unavailable'].includes(value) ? value : 'other'
}

module.exports = { initializeFixtureSse, inspectTurn, inspectFinalVisibility, closeFixtureDb: () => pool.end() }
