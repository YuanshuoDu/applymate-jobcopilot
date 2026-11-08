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
  const finalAnswer = await pool.query(`SELECT
    (SELECT COUNT(*) = 1 FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2
      AND "type" = 'agent_message' AND "phase" = 'final_answer') AS "exactlyOneFinalAssistantItem",
    EXISTS (SELECT 1 FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2
      AND "type" = 'agent_message' AND "phase" = 'final_answer' AND "status" = 'completed') AS "finalAssistantItemCompleted",
    EXISTS (SELECT 1 FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2
      AND "type" = 'agent_message' AND "phase" = 'final_answer' AND COALESCE("content"->>'text', '') <> '') AS "finalAssistantItemHasText",
    EXISTS (SELECT 1 FROM "agent_events" AS event JOIN "agent_items" AS item
      ON item."id" = event."itemId" AND item."sessionId" = event."sessionId" AND item."turnId" = event."turnId"
      WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = 'item.completed'
        AND event."payload"->>'itemId' = event."itemId" AND event."payload"->>'status' = 'completed'
        AND item."type" = 'agent_message' AND item."phase" = 'final_answer' AND item."status" = 'completed') AS "itemCompletedEventPersistsFinalAnswer",
    EXISTS (SELECT 1 FROM "agent_events" AS event JOIN "agent_items" AS item
      ON item."id" = event."itemId" AND item."sessionId" = event."sessionId" AND item."turnId" = event."turnId"
      WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = 'turn.completed'
        AND event."payload"->>'finalItemId' = event."itemId" AND item."type" = 'agent_message'
        AND item."phase" = 'final_answer' AND item."status" = 'completed') AS "completionEventTargetsFinalAnswer"`, [sessionId, turnId])
  const steps = await pool.query(`SELECT "status", "errorCode", "finishReason" FROM "agent_steps" WHERE "sessionId" = $1 AND "turnId" = $2 ORDER BY "ordinal", "attempt"`, [sessionId, turnId])
  const tasks = await pool.query(`SELECT "status", "failureReason" FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "turnId" = $2 ORDER BY "createdAt"`, [sessionId, turnId])
  const toolResults = await pool.query(`SELECT COUNT(*)::int AS count,
    BOOL_OR("content"->'output'->>'question' = '[REDACTED]') AS "questionRedacted"
    FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'tool_result'
      AND "content"->>'toolCallId' = 'fixture-native-question'`, [sessionId, turnId])
  return { turn: row, questions: items.rows, eventTypes: events.rows.map(event => event.type), steps: steps.rows, tasks: tasks.rows,
    finalAnswer: finalAnswer.rows[0], toolResultCount: toolResults.rows[0].count, toolResultQuestionRedacted: toolResults.rows[0].questionRedacted }
}

// The application/task linkage is synthetic; the question and Turn must
// already exist and be waiting through the real runtime before it is added.
async function attachFixtureApplication(sessionId, turnId) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const state = await client.query(`SELECT session."userId" AS owner
      FROM "agent_sessions" session JOIN "agent_turns" turn
        ON turn."sessionId" = session.id AND turn."userId" = session."userId"
      JOIN "User" candidate ON candidate.id = session."userId"
      WHERE session.id = $1 AND turn.id = $2 AND turn.status = 'waiting_for_user'
        AND candidate.email = 'candidate-a@example.invalid'
        AND (SELECT COUNT(*) FROM "agent_items" item WHERE item."sessionId" = session.id
          AND item."turnId" = turn.id AND item.type = 'question' AND item.status = 'started') = 1`, [sessionId, turnId])
    const empty = await client.query('SELECT (SELECT COUNT(*) FROM "Job")::int AS jobs, (SELECT COUNT(*) FROM "application_tasks")::int AS tasks')
    if (state.rowCount !== 1 || empty.rows[0].jobs !== 0 || empty.rows[0].tasks !== 0) throw new Error('Expected the isolated waiting question and empty application state')
    const owner = state.rows[0].owner
    await client.query(`INSERT INTO "Job" (id, "userId", company, role, source, status, "createdAt", "updatedAt")
      VALUES ('fixture-question-job', $1, 'Fixture Question Company', 'Fixture Question Engineer', 'fixture', 'saved', NOW(), NOW())`, [owner])
    await client.query(`INSERT INTO "application_tasks" (id, "userId", "jobId", "sessionId", status, checkpoint, "createdAt", "updatedAt")
      VALUES ('fixture-question-task', $1, 'fixture-question-job', $2, 'waiting_for_user', 'form_answer_required', NOW(), NOW())`, [owner, sessionId])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

async function inspectFixtureApplication(sessionId) {
  const result = await pool.query(`SELECT job.status AS "jobStatus", task.status AS "taskStatus", task."sessionId", candidate.email
    FROM "application_tasks" task JOIN "Job" job ON job.id = task."jobId" AND job."userId" = task."userId"
    JOIN "User" candidate ON candidate.id = task."userId"
    WHERE task.id = 'fixture-question-task' AND job.id = 'fixture-question-job' AND task."sessionId" = $1`, [sessionId])
  if (result.rowCount !== 1 || result.rows[0].email !== 'candidate-a@example.invalid') throw new Error('Unexpected fixture application scope')
  return result.rows[0]
}

module.exports = { initializeFixtureSse, attachFixtureApplication, inspectFixtureApplication, inspectTurn, closeFixtureDb: () => pool.end() }
