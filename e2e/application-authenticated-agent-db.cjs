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

async function inspectTurn(sessionId, turnId, expectedFinalText, expectedQuestionAnswer, includeQuestionDetails = false) {
  const database = await pool.query('SELECT current_database() AS name')
  if (database.rows[0]?.name !== 'application_flow_fixture') throw new Error('Unexpected database')
  const result = await pool.query(`SELECT turn."id", turn."status", turn."revision", turn."finalResponse", turn."error",
    session."userId" AS "sessionOwner", turn."userId" AS "turnOwner", candidate."email",
    (SELECT LEAST(COUNT(*), 9)::int FROM "agent_events" AS event WHERE event."sessionId" = session."id" AND event."turnId" = turn."id" AND event."type" = 'turn.completed') AS "completedEvents",
    (SELECT COUNT(*) > 9 FROM "agent_events" AS event WHERE event."sessionId" = session."id" AND event."turnId" = turn."id" AND event."type" = 'turn.completed') AS "completedEventsCapped",
    (SELECT LEAST(COUNT(*), 9)::int FROM "agent_events" AS event WHERE event."sessionId" = session."id" AND event."turnId" = turn."id" AND event."type" = 'question.answered') AS "answeredEvents",
    (SELECT COUNT(*) > 9 FROM "agent_events" AS event WHERE event."sessionId" = session."id" AND event."turnId" = turn."id" AND event."type" = 'question.answered') AS "answeredEventsCapped"
    FROM "agent_turns" AS turn JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
    JOIN "User" AS candidate ON candidate."id" = session."userId"
    WHERE session."id" = $1 AND turn."id" = $2`, [sessionId, turnId])
  const row = result.rows[0]
  const sessionTurnBindingMatches = result.rowCount === 1 && row.email === 'candidate-a@example.invalid' && row.turnOwner === row.sessionOwner
  const items = await pool.query(`SELECT "id", "status", "content", COALESCE("content"->>'answer' = $3, false) AS "answerMatches",
    LEAST(COUNT(*) OVER(), 9)::int AS "totalCount", (COUNT(*) OVER() > 9) AS "totalCountCapped"
    FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'question'
    ORDER BY "createdAt", "id" LIMIT 9`, [sessionId, turnId, expectedQuestionAnswer])
  const finalItems = await pool.query(`SELECT "type", "status", "phase",
    COALESCE("content"->>'text' = $3, false) AS "textMatches", LEAST(COUNT(*) OVER(), 9)::int AS "totalCount",
    (COUNT(*) OVER() > 9) AS "totalCountCapped"
    FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2
      AND "type" = 'agent_message' AND "phase" = 'final_answer' ORDER BY "createdAt", "id" LIMIT 9`,
  [sessionId, turnId, expectedFinalText])
  const events = await pool.query(`SELECT "type", LEAST(COUNT(*) OVER(), 9)::int AS "totalCount", (COUNT(*) OVER() > 9) AS "totalCountCapped"
    FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 ORDER BY "sequence" LIMIT 9`, [sessionId, turnId])
  const terminalEvents = await pool.query(`SELECT
    (event."payload"->>'finalItemId' IS NOT NULL) AS "finalItemPresent",
    EXISTS (SELECT 1 FROM "agent_items" AS final WHERE final."sessionId" = event."sessionId" AND final."turnId" = event."turnId"
      AND final."id" = (event."payload"->>'finalItemId') AND final."type" = 'agent_message' AND final."phase" = 'final_answer') AS "finalItemMatchesPersisted",
    COALESCE(event."itemId" = (event."payload"->>'finalItemId'), false) AS "eventItemBound",
    LEAST(COUNT(*) OVER(), 9)::int AS "totalCount", (COUNT(*) OVER() > 9) AS "totalCountCapped"
    FROM "agent_events" AS event WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = 'turn.completed'
    ORDER BY "sequence" LIMIT 9`, [sessionId, turnId])
  const steps = await pool.query(`SELECT "status", LEAST(COUNT(*) OVER(), 9)::int AS "totalCount", (COUNT(*) OVER() > 9) AS "totalCountCapped"
    FROM "agent_steps" WHERE "sessionId" = $1 AND "turnId" = $2 ORDER BY "ordinal", "attempt" LIMIT 9`, [sessionId, turnId])
  const tasks = await pool.query(`SELECT "status", LEAST(COUNT(*) OVER(), 9)::int AS "totalCount", (COUNT(*) OVER() > 9) AS "totalCountCapped"
    FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "turnId" = $2 ORDER BY "createdAt" LIMIT 9`, [sessionId, turnId])
  const finalAnswer = await pool.query(`SELECT
    (SELECT COUNT(*) = 1 FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2
      AND "type" = 'agent_message' AND "phase" = 'final_answer') AS "exactlyOneFinalAssistantItem",
    EXISTS (SELECT 1 FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2
      AND "type" = 'agent_message' AND "phase" = 'final_answer' AND "status" = 'completed') AS "finalAssistantItemCompleted",
    EXISTS (SELECT 1 FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2
      AND "type" = 'agent_message' AND "phase" = 'final_answer' AND COALESCE("content"->>'text', '') <> '') AS "finalAssistantItemHasText",
    EXISTS (SELECT 1 FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2
      AND "type" = 'agent_message' AND "phase" = 'final_answer' AND "status" = 'completed'
      AND "content"->>'text' = $3) AS "finalAssistantItemTextMatchesExpected",
    EXISTS (SELECT 1 FROM "agent_events" AS event JOIN "agent_items" AS item
      ON item."id" = event."itemId" AND item."sessionId" = event."sessionId" AND item."turnId" = event."turnId"
      WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = 'item.completed'
        AND event."payload"->>'itemId' = event."itemId" AND event."payload"->>'status' = 'completed'
        AND item."type" = 'agent_message' AND item."phase" = 'final_answer' AND item."status" = 'completed') AS "itemCompletedEventPersistsFinalAnswer",
    EXISTS (SELECT 1 FROM "agent_events" AS event JOIN "agent_items" AS item
      ON item."id" = event."itemId" AND item."sessionId" = event."sessionId" AND item."turnId" = event."turnId"
      WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = 'turn.completed'
        AND event."payload"->>'finalItemId' = event."itemId" AND item."type" = 'agent_message'
        AND item."phase" = 'final_answer' AND item."status" = 'completed') AS "completionEventTargetsFinalAnswer"`,
  [sessionId, turnId, expectedFinalText])
  const toolResults = await pool.query(`SELECT LEAST(COUNT(*), 9)::int AS count, (COUNT(*) > 9) AS "countCapped",
    BOOL_OR("content"->'output'->>'question' = '[REDACTED]') AS "questionRedacted"
    FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'tool_result'
      AND "content"->>'toolCallId' = 'fixture-native-question'`, [sessionId, turnId])
  const withoutCount = rows => rows.map(({ totalCount, totalCountCapped, ...value }) => value)
  const turn = {
    status: row?.status ?? 'missing',
    errorPresent: row?.error !== null && row?.error !== undefined,
    completedEvents: row?.completedEvents ?? 0,
    completedEventsCapped: row?.completedEventsCapped ?? false,
    answeredEvents: row?.answeredEvents ?? 0,
    answeredEventsCapped: row?.answeredEventsCapped ?? false,
    finalResponsePresent: row?.finalResponse !== null && row?.finalResponse !== undefined,
    finalResponseMatches: typeof row?.finalResponse === 'string' && row.finalResponse.includes(expectedFinalText),
  }
  const questions = includeQuestionDetails
    ? items.rows.map(({ id, status, content }) => ({ id, status, content }))
    : items.rows.map(({ status }) => ({ status }))
  return {
    turn, sessionTurnBindingMatches,
    questionCount: items.rows[0]?.totalCount ?? 0,
    questionCountCapped: items.rows[0]?.totalCountCapped ?? false,
    questions,
    questionAnswerMatches: items.rows.length === 1 && items.rows[0].answerMatches === true,
    finalAnswer: finalAnswer.rows[0],
    finalItemCount: finalItems.rows[0]?.totalCount ?? 0,
    finalItemCountCapped: finalItems.rows[0]?.totalCountCapped ?? false,
    finalItems: withoutCount(finalItems.rows),
    eventCount: events.rows[0]?.totalCount ?? 0,
    eventCountCapped: events.rows[0]?.totalCountCapped ?? false,
    eventTypes: events.rows.map(event => event.type),
    terminalEventCount: terminalEvents.rows[0]?.totalCount ?? 0,
    terminalEventCountCapped: terminalEvents.rows[0]?.totalCountCapped ?? false,
    terminalEvents: withoutCount(terminalEvents.rows),
    stepCount: steps.rows[0]?.totalCount ?? 0,
    stepCountCapped: steps.rows[0]?.totalCountCapped ?? false,
    steps: withoutCount(steps.rows),
    taskCount: tasks.rows[0]?.totalCount ?? 0,
    taskCountCapped: tasks.rows[0]?.totalCountCapped ?? false,
    tasks: withoutCount(tasks.rows),
    toolResultCount: toolResults.rows[0].count,
    toolResultCountCapped: toolResults.rows[0].countCapped,
    toolResultQuestionRedacted: toolResults.rows[0].questionRedacted,
  }
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
function installAgentPageDiagnostics() {
  const diagnostics = { completionEventDelivered: false, completionEventTargetsExpectedSessionAndTurn: false,
    completionEventFinalItemIdMatchesEnvelopeItemId: false, finalItemCompletedEventDelivered: false,
    finalItemHydrationRequestAttempted: false, finalItemHydrationTargetsExpectedItem: false,
    finalItemHydrationSessionBindingMatches: false, finalItemHydrationTurnBindingMatches: false,
    finalItemHydrationResponseOk: false, finalItemHydrationTextMatchesExpected: false, finalItemHydrationSucceeded: false,
  }
  const completedItems = new Set(), pendingTimelineIds = new Set(), pendingHydrationAppliers = new Map(); let expectedSessionId = '', expectedTurnId = '', expectedFinalText = '', finalItemId = null
  Object.defineProperty(window, '__agentQuestionDiagnostics', { value: diagnostics })
  Object.defineProperty(window, '__configureAgentQuestionDiagnostics', { value: (sessionId, turnId, finalText) => { expectedSessionId = sessionId; expectedTurnId = turnId; expectedFinalText = finalText } })
  const nativeFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    let url = null
    try {
      url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url, window.location.href)
    } catch { /* URL inspection must not change fetch behavior. */ }
    const sessionMatch = url?.pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/(events|timeline)$/)
    let pathSessionId = null
    try { pathSessionId = sessionMatch ? decodeURIComponent(sessionMatch[1]) : null } catch { /* Keep the binding false. */ }
    const requestSessionMatchesExpected = pathSessionId !== null && pathSessionId === expectedSessionId
    const requestedItemId = sessionMatch?.[2] === 'timeline' && requestSessionMatchesExpected ? url.searchParams.get('itemId') : null
    if (requestedItemId) {
      pendingTimelineIds.add(requestedItemId)
      diagnostics.finalItemHydrationRequestAttempted = true
      if (requestedItemId === finalItemId) {
        diagnostics.finalItemHydrationTargetsExpectedItem = true
        diagnostics.finalItemHydrationSessionBindingMatches = true
        diagnostics.finalItemHydrationTurnBindingMatches = diagnostics.completionEventTargetsExpectedSessionAndTurn && completedItems.has(requestedItemId)
      }
    }
    const response = await nativeFetch(input, init)
    if (!url) return response
    const parsedUrl = url
    if (parsedUrl.pathname.endsWith('/events') && response.headers.get('content-type')?.includes('text/event-stream')) {
      const reader = response.clone().body?.getReader()
      if (reader) void (async () => {
        try {
          const decoder = new TextDecoder()
          let buffered = ''
          let eventType = ''
          let dataLines = []
          const inspectFrame = () => {
            const streamSessionMatches = pathSessionId !== null && pathSessionId === expectedSessionId
            if (eventType === 'item.completed' || eventType === 'turn.completed') {
              try {
                const envelope = JSON.parse(dataLines.join('\n'))
                const payload = envelope.payload && typeof envelope.payload === 'object' && !Array.isArray(envelope.payload)
                  ? envelope.payload : null
                const eventTurnId = typeof envelope.turnId === 'string' ? envelope.turnId
                  : typeof payload?.turnId === 'string' ? payload.turnId : null
                const expectedTurnEvent = streamSessionMatches && eventTurnId === expectedTurnId
                if (eventType === 'item.completed' && expectedTurnEvent && typeof envelope.itemId === 'string') {
                  completedItems.add(envelope.itemId)
                  if (envelope.itemId === finalItemId) { diagnostics.finalItemCompletedEventDelivered = true; pendingHydrationAppliers.get(envelope.itemId)?.() }
                }
                if (eventType === 'turn.completed') {
                  diagnostics.completionEventDelivered = streamSessionMatches
                  diagnostics.completionEventTargetsExpectedSessionAndTurn = expectedTurnEvent
                  if (expectedTurnEvent && payload && typeof payload.finalItemId === 'string') {
                    finalItemId = payload.finalItemId
                    diagnostics.completionEventFinalItemIdMatchesEnvelopeItemId = envelope.itemId === finalItemId
                    diagnostics.finalItemCompletedEventDelivered = completedItems.has(finalItemId)
                    if (pendingTimelineIds.has(finalItemId)) { diagnostics.finalItemHydrationRequestAttempted = true; diagnostics.finalItemHydrationTargetsExpectedItem = true; pendingHydrationAppliers.get(finalItemId)?.() }
                  }
                }
              } catch { /* Malformed payloads leave the identity checks false. */ }
            }
            eventType = ''
            dataLines = []
          }
          while (true) {
            const next = await reader.read()
            if (next.done) return
            buffered += decoder.decode(next.value, { stream: true })
            const lines = buffered.split(/\r?\n/)
            buffered = lines.pop() ?? ''
            for (const line of lines) {
              if (!line) inspectFrame()
              else if (line.startsWith('event:')) eventType = line.slice(6).trim()
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
            }
          }
        } catch { /* Delivery stays false only when no completion frame was observed. */ }
      })()
    }
    if (requestedItemId) {
      if (requestedItemId === finalItemId) {
        diagnostics.finalItemHydrationTargetsExpectedItem = true
        diagnostics.finalItemHydrationSessionBindingMatches = true
        diagnostics.finalItemHydrationTurnBindingMatches = diagnostics.completionEventTargetsExpectedSessionAndTurn && completedItems.has(requestedItemId)
        diagnostics.finalItemHydrationResponseOk = response.ok
      }
      const hydration = { responseOk: response.ok, itemMatches: false, textMatches: false, sessionMatches: requestSessionMatchesExpected, turnMatches: false, turnIdObserved: false }
      const applyHydration = () => {
        if (requestedItemId !== finalItemId) return
        if (!hydration.turnIdObserved) hydration.turnMatches = diagnostics.completionEventTargetsExpectedSessionAndTurn && completedItems.has(requestedItemId)
        diagnostics.finalItemHydrationRequestAttempted = true
        diagnostics.finalItemHydrationTargetsExpectedItem = true
        diagnostics.finalItemHydrationSessionBindingMatches = hydration.sessionMatches
        diagnostics.finalItemHydrationTurnBindingMatches = hydration.turnMatches
        diagnostics.finalItemHydrationResponseOk = hydration.responseOk
        diagnostics.finalItemHydrationTextMatchesExpected = hydration.textMatches
        diagnostics.finalItemHydrationSucceeded = hydration.responseOk && hydration.itemMatches
          && hydration.textMatches && hydration.sessionMatches && hydration.turnMatches
      }
      pendingHydrationAppliers.set(requestedItemId, applyHydration)
      applyHydration()
      if (response.ok) {
        try {
          void response.clone().json().then(body => {
            const item = Array.isArray(body.items) && body.items.length === 1 ? body.items[0] : null
            const content = item?.content && typeof item.content === 'object' && !Array.isArray(item.content) ? item.content : null
            hydration.itemMatches = item?.id === requestedItemId && item.type === 'agent_message' && item.status === 'completed' && item.phase === 'final_answer'
            hydration.textMatches = typeof content?.text === 'string' && content.text === expectedFinalText
            hydration.sessionMatches = typeof item?.sessionId === 'string' ? item.sessionId === expectedSessionId : requestSessionMatchesExpected
            hydration.turnIdObserved = typeof item?.turnId === 'string'
            hydration.turnMatches = hydration.turnIdObserved ? item.turnId === expectedTurnId
              : diagnostics.completionEventTargetsExpectedSessionAndTurn && completedItems.has(requestedItemId)
            applyHydration()
          }).catch(applyHydration)
        } catch { applyHydration() }
      }
    }
    return response
  }
}
module.exports = { initializeFixtureSse, attachFixtureApplication, inspectFixtureApplication, inspectTurn, installAgentPageDiagnostics, closeFixtureDb: () => pool.end() }
