import { createHash } from "node:crypto"
import type pg from "pg"
import { scheduledAutomationCriteria } from "./scheduled-automation-snapshot.js"
import { loadTaskGraphVerificationReceipts } from "./task-graph-pg-verification-receipts.js"
import type { TaskGraphVerificationScope } from "./task-graph-pg-verification-receipt-validation.js"
import type { TaskGraphVerificationDependencyBinding } from "./task-graph-verification-report.js"
import { canonicalTaskGraphJson, type StoredTaskGraphNode } from "./task-graph-snapshot.js"

type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type CompletedReceipts = Awaited<ReturnType<typeof loadTaskGraphVerificationReceipts>>
const EMPTY_ANALYST_DOMAIN = "agent-harness.v2.task-graph.empty-analyst-coverage-unmet.v2"

/** Reject current or unowned tool receipts; recognize old events only inside a verified closed task Step. */
export async function hasNoCurrentAttemptTaskGraphToolReceipts(client: Queryable, scope: TaskGraphVerificationScope): Promise<boolean> {
  const values = [scope.taskId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId, scope.attemptCount]
  const items = await client.query(`SELECT item."id" FROM "agent_steps" AS step
    JOIN "agent_items" AS item ON item."stepId" = step."id"
    JOIN "sub_agent_tasks" AS task ON task."id" = step."taskId" AND task."sessionId" = step."sessionId" AND task."turnId" = step."turnId"
    JOIN "agent_sessions" AS session ON session."id" = step."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = step."turnId" AND turn."sessionId" = step."sessionId"
    WHERE step."taskId" = $1 AND step."sessionId" = $2 AND step."turnId" = $3 AND task."rootTaskId" = $4
      AND turn."rootTaskId" = $4 AND task."parentTaskId" = $5 AND session."userId" = $6 AND turn."userId" = $6
      AND step."attempt" = $7 AND item."type" IN ('tool_call', 'tool_result') LIMIT 1`, values)
  if (items.rows.length > 0) return false
  const misboundItems = await client.query(`SELECT item."id" FROM "agent_items" AS item LEFT JOIN "agent_steps" AS step ON step."id" = item."stepId"
    WHERE item."taskId" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND item."type" IN ('tool_call', 'tool_result')
      AND (step."id" IS NULL OR step."sessionId" IS DISTINCT FROM item."sessionId" OR step."turnId" IS DISTINCT FROM item."turnId"
        OR step."taskId" IS DISTINCT FROM item."taskId" OR step."attempt" = $4) LIMIT 1`, [scope.taskId, scope.sessionId, scope.turnId, scope.attemptCount])
  if (misboundItems.rows.length > 0) return false
  const events = await client.query(`WITH task_attempt_steps AS (
      SELECT step."id", step."attempt", step."ordinal", step."status" FROM "agent_steps" AS step
      JOIN "sub_agent_tasks" AS task ON task."id" = step."taskId" AND task."sessionId" = step."sessionId" AND task."turnId" = step."turnId"
      JOIN "agent_sessions" AS session ON session."id" = step."sessionId" JOIN "agent_turns" AS turn ON turn."id" = step."turnId" AND turn."sessionId" = step."sessionId"
      WHERE step."taskId" = $1 AND step."sessionId" = $2 AND step."turnId" = $3 AND task."rootTaskId" = $4 AND turn."rootTaskId" = $4 AND task."parentTaskId" = $5 AND session."userId" = $6 AND turn."userId" = $6
    ), task_attempt_items AS (
      SELECT item."id", item."type", item."content", item."taskId", step."id" AS "stepId", step."attempt" FROM task_attempt_steps AS step
        JOIN "agent_items" AS item ON item."stepId" = step."id" AND item."sessionId" = $2 AND item."turnId" = $3
    ), current_attempt_items AS (SELECT item."id", item."type", item."content" FROM task_attempt_items AS item WHERE item."attempt" = $7),
    prior_task_tool_calls AS (
      SELECT item."id", item."stepId", item."content"->>'toolCallId' AS "toolCallId" FROM task_attempt_items AS item WHERE item."attempt" < $7 AND item."type" = 'tool_call' AND item."taskId" = $1
    ), prior_step_boundaries AS (
      SELECT step."id" AS "stepId", started."sequence" AS "startSequence", closed."sequence" AS "closeSequence"
      FROM task_attempt_steps AS step JOIN "agent_events" AS started ON started."sessionId" = $2 AND started."turnId" = $3 AND started."taskId" = $1 AND started."itemId" IS NULL AND started."type" = 'step.started' AND started."actor" = 'subagent'
        AND started."correlationId" = step."id" AND started."idempotencyKey" = 'task:' || $1 || ':event:step-started:' || step."id"
        AND started."payload" = jsonb_build_object('stepId', step."id", 'ordinal', step."ordinal", 'taskId', $1)
      JOIN "agent_events" AS closed ON closed."sessionId" = $2 AND closed."turnId" = $3 AND closed."taskId" = $1 AND closed."itemId" IS NULL AND closed."type" = 'step.completed' AND closed."actor" = 'subagent'
        AND closed."correlationId" = step."id" AND closed."idempotencyKey" = 'task:' || $1 || ':event:step-completed:' || step."id"
        AND closed."payload"->>'stepId' = step."id" AND closed."payload"->>'taskId' = $1
        AND closed."payload"->>'status' = 'completed' AND closed."payload"->>'toolCallCount' ~ '^[1-9][0-9]*$' WHERE step."attempt" < $7 AND step."status" = 'completed' AND started."sequence" < closed."sequence"
    ) SELECT event."id" FROM "agent_events" AS event
      JOIN "agent_sessions" AS session ON session."id" = event."sessionId" JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
      WHERE event."sessionId" = $2 AND event."turnId" = $3 AND session."userId" = $6 AND turn."userId" = $6
        AND event."type" IN ('tool_call.started', 'tool_call.completed', 'tool_call.failed', 'tool_call.interrupted')
        AND (event."itemId" IN (SELECT item."id" FROM current_attempt_items AS item)
          OR event."correlationId" IN (SELECT item."content"->>'toolCallId' FROM current_attempt_items AS item WHERE item."type" = 'tool_call')
          OR event."payload"->>'toolCallId' IN (SELECT item."content"->>'toolCallId' FROM current_attempt_items AS item WHERE item."type" = 'tool_call')
          OR (event."taskId" = $1 AND NOT EXISTS (
            SELECT 1 FROM prior_task_tool_calls AS prior JOIN prior_step_boundaries AS boundary ON boundary."stepId" = prior."stepId"
            WHERE (event."itemId" = prior."id" OR (event."itemId" IS NULL AND event."actor" = 'subagent'
                AND left(event."idempotencyKey", length('task:' || $1 || ':tool-lifecycle:' || prior."toolCallId" || ':')) = 'task:' || $1 || ':tool-lifecycle:' || prior."toolCallId" || ':'
                AND substring(event."idempotencyKey" FROM length('task:' || $1 || ':tool-lifecycle:' || prior."toolCallId" || ':') + 1) ~ CASE event."type"
                  WHEN 'tool_call.started' THEN '^started:[0-9a-f]{24}$' WHEN 'tool_call.completed' THEN '^completed:[0-9a-f]{24}$'
                  WHEN 'tool_call.failed' THEN '^(failed|cancelled):[0-9a-f]{24}$' ELSE '$a' END))
              AND event."correlationId" = prior."toolCallId" AND event."payload"->>'toolCallId' = prior."toolCallId"
              AND event."sequence" > boundary."startSequence" AND event."sequence" < boundary."closeSequence"
          )))
      LIMIT 1`, values)
  return events.rows.length === 0
}

/** Binds all independently reverified Scout reports without projecting them as Analyst evidence. */
export function emptyAnalystCoverageDigest(input: Readonly<{
  scope: TaskGraphVerificationScope
  node: StoredTaskGraphNode
  resultDigest: string
  dependencyNodeKeys: readonly string[]
  dependencyBindings: readonly TaskGraphVerificationDependencyBinding[]
}>): string | undefined {
  if (!isDigest(input.resultDigest)
    || input.node.taskId !== input.scope.taskId || input.node.templateId !== "analyst"
    || !validBindings(input.dependencyNodeKeys, input.dependencyBindings)) return undefined
  try {
    const dependencyBindings = [...input.dependencyBindings].sort((left, right) => compareKeys(left.nodeKey, right.nodeKey))
    return hash(canonicalTaskGraphJson({
      schemaVersion: EMPTY_ANALYST_DOMAIN,
      scope: {
        userId: input.scope.userId, sessionId: input.scope.sessionId, turnId: input.scope.turnId,
        rootTaskId: input.scope.rootTaskId, parentTaskId: input.scope.parentTaskId,
        taskId: input.scope.taskId, attemptCount: input.scope.attemptCount,
      },
      analystNodeDigest: hash(canonicalTaskGraphJson(input.node)),
      resultDigest: input.resultDigest,
      analystReceipts: { currentAttemptItems: [], currentAttemptEvents: [] },
      dependencyBindings,
    }))
  } catch { return undefined }
}

/** Existing scheduled Scout empty-discovery proof. Its digest format remains unchanged. */
export async function completedZeroDiscoveryDigest(
  client: Queryable,
  scope: TaskGraphVerificationScope,
  receipts: CompletedReceipts,
  task: Row,
): Promise<string | undefined> {
  if (receipts.replayReceipts.length > 0) return undefined
  const calls = receipts.items.filter(item => item.type === "tool_call")
  const results = receipts.items.filter(item => item.type === "tool_result")
  if (calls.length < 1 || calls.length > 32 || receipts.items.length !== calls.length * 2
    || results.length !== calls.length || receipts.outcomes.size !== calls.length) return undefined
  const turnInput = record(task.turnInput), criteria = scheduledAutomationCriteria(turnInput)
  if (task.turnSource !== "automation" || task.turnExecutionMode !== "canonical_task_graph" || turnInput?.automationRunMode !== "scheduled" || !criteria) return undefined
  const callIds = new Set<string>(), ordinals = new Set<string>(), resultById = new Map<string, Row>()
  for (const item of results) {
    const content = record(item.content), callId = content && strictText(content.toolCallId) ? content.toolCallId : undefined
    if (!callId || resultById.has(callId)) return undefined
    resultById.set(callId, item)
  }
  const callReceipts: Array<Record<string, unknown>> = []
  for (const call of calls) {
    const content = record(call.content), callId = content && strictText(content.toolCallId) ? content.toolCallId : undefined
    const stepId = strictText(call.stepId) ? call.stepId : undefined
    const result = callId ? resultById.get(callId) : undefined, resultContent = record(result?.content)
    const ordinalKey = `${String(call.stepId)}\u0000${String(call.ordinal)}`
    if (!content || !callId || !stepId || callIds.has(callId) || content.toolName !== "jobs.discover" || content.toolVersion !== "1"
      || content.status !== "completed" || content.errorCode !== null || receipts.outcomes.get(callId) !== "completed"
      || !result || !resultContent || resultContent.errorCode !== null || !Object.hasOwn(resultContent, "output")
      || ordinalKey !== `${String(result.stepId)}\u0000${String(result.ordinal)}` || ordinals.has(ordinalKey)) return undefined
    if (!matchesScheduledDiscoveryInput(content.input, criteria)) return undefined
    const output = record(resultContent.output)
    if (!validEmptyDiscoveryOutput(output, content, stepId, scope)) return undefined
    callIds.add(callId)
    ordinals.add(ordinalKey)
    callReceipts.push({
      callId, stepId: call.stepId, ordinal: Number(call.ordinal),
      callItem: [call.id, Number(call.revision)], resultItem: [result.id, Number(result.revision)],
      inputDigest: hash(canonicalTaskGraphJson(content.input)), outputDigest: hash(canonicalTaskGraphJson(resultContent.output)),
    })
  }
  if (callIds.size !== calls.length) return undefined
  const eventRows = await client.query(`SELECT event."id", event."itemId", event."taskId", event."correlationId", event."type", event."payload", event."sequence" FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId" JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId" WHERE event."sessionId" = $1 AND event."turnId" = $2 AND session."userId" = $3 AND turn."userId" = $3 AND event."itemId" = ANY($4::text[]) AND event."type" IN ('tool_call.started', 'tool_call.completed') ORDER BY event."sequence" ASC LIMIT 97`,
  [scope.sessionId, scope.turnId, scope.userId, calls.map(call => String(call.id))])
  if (eventRows.rows.length !== calls.length * 2) return undefined
  const eventsByItem = new Map<string, Row[]>(), eventIds = new Set<string>()
  for (const value of eventRows.rows) {
    const event = record(value)
    if (!event || !strictText(event.id) || eventIds.has(event.id) || !strictText(event.itemId)) return undefined
    eventIds.add(event.id)
    const group = eventsByItem.get(event.itemId) ?? []
    group.push(event)
    eventsByItem.set(event.itemId, group)
  }
  const eventReceipts: Array<Record<string, unknown>> = []
  for (const call of calls) {
    const content = record(call.content), callId = content?.toolCallId
    const output = resultById.get(String(callId)) && record(resultById.get(String(callId))?.content)?.output
    const events = eventsByItem.get(String(call.id)) ?? []
    const started = events.find(event => event.type === "tool_call.started"), completed = events.find(event => event.type === "tool_call.completed")
    const startPayload = record(started?.payload), completedPayload = record(completed?.payload)
    if (events.length !== 2 || !started || !completed || !startPayload || !completedPayload
      || started.taskId !== scope.taskId || completed.taskId !== scope.taskId
      || started.correlationId !== callId || completed.correlationId !== callId
      || !Number.isSafeInteger(Number(started.sequence)) || !Number.isSafeInteger(Number(completed.sequence))
      || Number(started.sequence) >= Number(completed.sequence)
      || !eventMatchesTool(startPayload, scope.taskId, String(callId), "jobs.discover", "1")
      || !eventMatchesTool(completedPayload, scope.taskId, String(callId), "jobs.discover", "1")
      || completedPayload.status !== "completed" || completedPayload.errorCode !== null
      || canonicalTaskGraphJson(completedPayload.output) !== canonicalTaskGraphJson(output)) return undefined
    eventReceipts.push(...[started, completed].map(event => ({ id: event.id, type: event.type, sequence: Number(event.sequence), payloadDigest: hash(canonicalTaskGraphJson(event.payload)) })))
  }
  callReceipts.sort((a, b) => Number(a.ordinal) - Number(b.ordinal) || String(a.callId).localeCompare(String(b.callId)))
  eventReceipts.sort((a, b) => Number(a.sequence) - Number(b.sequence) || String(a.id).localeCompare(String(b.id)))
  return hash(canonicalTaskGraphJson({
    schemaVersion: "agent-harness.v2.task-graph.empty-discovery-receipt.v1",
    scope: { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
      parentTaskId: scope.parentTaskId, taskId: scope.taskId, attemptCount: scope.attemptCount },
    calls: callReceipts, events: eventReceipts,
  }))
}

function validEmptyDiscoveryOutput(output: Row | undefined, call: Row, stepId: string, scope: TaskGraphVerificationScope): boolean {
  if (!output || !exactRecord(output, "evidence,jobs,nextCursor,usage") || !emptyDenseArray(output.jobs) || !emptyDenseArray(output.evidence) || output.nextCursor !== null) return false
  const usage = exactRecord(output.usage, "aiCalls,durationMs,estimatedCostUsd,jobsFailed,jobsProcessed,jobsSucceeded,ledgerKey,providerFailures,providers,requests,sessionId,stepId,toolCallId,toolName,toolVersion,turnId")
  return Boolean(usage && usage.ledgerKey === [scope.userId, scope.sessionId, scope.turnId, stepId, String(call.toolCallId)].join(":")
    && usage.toolName === "jobs.discover" && usage.toolVersion === "1" && usage.toolCallId === call.toolCallId
    && usage.sessionId === scope.sessionId && usage.turnId === scope.turnId && usage.stepId === stepId
    && nonNegativeInteger(usage.requests) && Number(usage.requests) >= 1 && usage.jobsProcessed === 0 && usage.jobsSucceeded === 0
    && usage.jobsFailed === 0 && usage.providerFailures === 0 && usage.aiCalls === 0 && nonNegativeInteger(usage.durationMs)
    && typeof usage.estimatedCostUsd === "number" && Number.isFinite(usage.estimatedCostUsd) && usage.estimatedCostUsd === 0
    && denseStrings(usage.providers, 32, 80) && usage.providers.length > 0 && new Set(usage.providers).size === usage.providers.length)
}

function matchesScheduledDiscoveryInput(value: unknown, criteria: ReturnType<typeof scheduledAutomationCriteria>): boolean {
  const input = exactRecord(value, "targetLocations,targetRoles"), roles = input?.targetRoles, locations = input?.targetLocations
  return Boolean(criteria && denseStrings(roles, 8, 160) && denseStrings(locations, 8, 160)
    && canonicalTaskGraphJson(roles) === canonicalTaskGraphJson(criteria.targetRoles) && canonicalTaskGraphJson(locations) === canonicalTaskGraphJson(criteria.targetLocations))
}

function eventMatchesTool(payload: Row, taskId: string, callId: string, toolName: string, toolVersion: string): boolean {
  return payload.taskId === taskId && payload.toolCallId === callId && payload.toolName === toolName && payload.toolVersion === toolVersion
}

function validBindings(keys: readonly string[], bindings: readonly TaskGraphVerificationDependencyBinding[]): boolean {
  if (keys.length < 2 || keys.length > 8 || bindings.length !== keys.length) return false
  const expected = [...keys].sort(compareKeys)
  if (new Set(expected).size !== expected.length || expected.some(key => !strictText(key) || key.length > 128)) return false
  const actual = [...bindings].sort((left, right) => compareKeys(left.nodeKey, right.nodeKey))
  return actual.every((binding, index) => binding.nodeKey === expected[index] && strictText(binding.taskId)
    && Number.isSafeInteger(binding.attemptCount) && binding.attemptCount >= 1
    && [binding.nodeDigest, binding.resultDigest, binding.evidenceDigest, binding.reportDigest].every(isDigest))
}

function exactRecord(value: unknown, keys: string): Row | undefined {
  const parsed = record(value)
  if (!parsed) return undefined
  try {
    const ownKeys = Reflect.ownKeys(value as object), descriptors = Object.getOwnPropertyDescriptors(value as object)
    return ownKeys.some(key => typeof key !== "string") || (ownKeys as string[]).sort().join(",") !== keys
      || ownKeys.some(key => !descriptors[key as string]?.enumerable || !("value" in descriptors[key as string]!)) ? undefined : parsed
  } catch { return undefined }
}

function record(value: unknown): Row | undefined {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return undefined } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : undefined } catch { return undefined }
}

function emptyDenseArray(value: unknown): boolean {
  try { return Array.isArray(value) && Reflect.ownKeys(value).length === 1 && Object.getOwnPropertyDescriptor(value, "length")?.value === 0 } catch { return false }
}

function denseStrings(value: unknown, maximum: number, maxLength: number): value is string[] {
  try {
    if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1 || value.length > maximum) return false
    for (let index = 0; index < value.length; index++) {
      const item = Object.getOwnPropertyDescriptor(value, String(index))
      if (!item?.enumerable || !("value" in item) || !strictText(item.value) || item.value.length > maxLength) return false
    }
    return true
  } catch { return false }
}

function nonNegativeInteger(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0 }
function strictText(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 }
function isDigest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) }
function compareKeys(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex") }
