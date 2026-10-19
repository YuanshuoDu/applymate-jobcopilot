import type pg from "pg"
import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import { parsePersistedTaskGraphReceipt } from "./task-graph-pg-event-validation.js"
import { taskGraphItemId, type TaskGraphSnapshot } from "./task-graph-snapshot.js"

const MAX_PG_BIGINT = (1n << 63n) - 1n
const MAX_INPUT_IDS = 256
export const TASK_GRAPH_SOURCE_STEP_BATCH_LIMIT = TASK_GRAPH_LIMITS.maxNodes + 2

export type TaskGraphSourceCheckpoint = Readonly<{ inputThroughSequence: bigint }>
export type TaskGraphInputRelation = "predates_current_inputs" | "covers_current_inputs" | "unknown"
export type TaskGraphSourceIntent = Readonly<{
  goal: string
  successCriteria: readonly string[]
  inputRelation: TaskGraphInputRelation
}>
export type TaskGraphSourceIntentNode = TaskGraphSourceIntent & Readonly<{ nodeKey: string }>
export type TaskGraphSourceProvenance = Readonly<{
  sourceInputCheckpointByNodeKey: ReadonlyMap<string, TaskGraphSourceCheckpoint | null>
  sourceInputRelationByNodeKey: ReadonlyMap<string, TaskGraphInputRelation>
  currentInputCheckpoint: TaskGraphSourceCheckpoint | null
}>
export type TaskGraphSourceLoadOptions = Readonly<{
  currentStepId?: string
  currentStepAttempt?: number
  discoverCurrentStep?: boolean
}>
type GraphScope = Readonly<{ userId: string; sessionId: string; turnId: string; rootTaskId: string; parentTaskId: string }>
type LoadedItem = Readonly<{ id: string; revision: number }>
type Row = Record<string, unknown>
type Queryable = Pick<pg.PoolClient, "query">

function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : null
}

function text(value: unknown, limit = 128): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit && value.trim() === value
}

function denseArray(value: unknown, maximum: number): value is unknown[] {
  return Array.isArray(value) && value.length <= maximum && Reflect.ownKeys(value).length === value.length + 1
    && Reflect.ownKeys(value).every(key => key === "length" || typeof key === "string"
      && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length)
}

function checkpointSequence(value: unknown): bigint | null {
  try {
    const parsed = typeof value === "bigint" ? value
      : typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value)
        : typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : -1n
    return parsed >= 0n && parsed <= MAX_PG_BIGINT ? parsed : null
  } catch { return null }
}

function checkpointIds(value: unknown): string[] | null {
  const parsed = object(value) === null && typeof value === "string"
    ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!denseArray(parsed, MAX_INPUT_IDS)) return null
  const ids = parsed.map(id => text(id, 256) ? id : null)
  return ids.every((id): id is string => id !== null) && new Set(ids).size === ids.length ? ids : null
}

/** Returns no checkpoint for malformed or impossible persisted Step data. */
export function parseTaskGraphSourceCheckpoint(throughSequence: unknown, inputIds: unknown): TaskGraphSourceCheckpoint | null {
  const inputThroughSequence = checkpointSequence(throughSequence)
  return inputThroughSequence === null || checkpointIds(inputIds) === null ? null : { inputThroughSequence }
}

/** Provenance is advisory: only a strictly earlier known checkpoint is stale. */
export function taskGraphInputRelation(
  source: TaskGraphSourceCheckpoint | null | undefined,
  current: TaskGraphSourceCheckpoint | null | undefined,
): TaskGraphInputRelation {
  if (!source || !current || source.inputThroughSequence > current.inputThroughSequence) return "unknown"
  return source.inputThroughSequence < current.inputThroughSequence ? "predates_current_inputs" : "covers_current_inputs"
}

/** Rebuilds node-to-Step causes from receipts already accepted by the persisted receipt parser. */
export function taskGraphProposalCausationByNodeKey(
  events: readonly unknown[], loaded: LoadedItem, snapshot: TaskGraphSnapshot, scope: GraphScope,
): ReadonlyMap<string, string | null> {
  const current = new Map(snapshot.nodes.map(node => [node.key, node.taskId] as const))
  const causes = new Map<string, string | null>(), ambiguous = new Set<string>()
  for (const value of events) {
    const event = object(value), payload = object(event?.payload)
    if (!event || !payload || payload.kind !== "proposal") continue
    try {
      parsePersistedTaskGraphReceipt(event.type, payload, loaded, snapshot, scope, {
        type: event.type, itemId: event.itemId, taskId: event.taskId, idempotencyKey: event.idempotencyKey,
      })
    } catch { continue }
    const receipt = object(payload.receipt), receiptItem = object(payload.item)
    if (!receipt || !Array.isArray(receipt.nodes)) continue
    const validCause = event.type === (Number(payload.revision) === 1 ? "item.started" : "item.delta")
      && event.actor === "orchestrator" && event.correlationId === scope.turnId
      && event.itemId === taskGraphItemId(scope.parentTaskId) && event.taskId === scope.parentTaskId
      && text(event.causationId) && receiptItem?.stepId === event.causationId
      ? event.causationId : null
    for (const raw of receipt.nodes) {
      const node = object(raw)
      if (!node || current.get(String(node.key)) !== node.taskId) continue
      const key = String(node.key)
      if (causes.has(key)) { ambiguous.add(key); causes.set(key, null) }
      else causes.set(key, validCause)
    }
  }
  for (const key of ambiguous) causes.set(key, null)
  return causes
}

export type TaskGraphSourceStepExpectation = Readonly<{
  stepId: string; attempt: number; userId: string; sessionId: string; turnId: string; rootTaskId: string; parentTaskId: string
}>

function ownedStep(row: Row | null, expected: TaskGraphSourceStepExpectation): row is Row {
  return Boolean(row && row.id === expected.stepId && row.attempt === expected.attempt
    && row.userId === expected.userId && row.turnUserId === expected.userId
    && row.sessionId === expected.sessionId && row.turnId === expected.turnId && row.rootTaskId === expected.rootTaskId
    && row.taskId === expected.parentTaskId && row.checkpointInputsValid === true)
}

function persistedStepCheckpoint(row: Row): TaskGraphSourceCheckpoint | null {
  const checkpoint = parseTaskGraphSourceCheckpoint(row.inputThroughSequence, row.consumedInputIds)
  const sessionEventSequence = checkpointSequence(row.sessionEventSequence)
  return checkpoint && sessionEventSequence !== null && checkpoint.inputThroughSequence <= sessionEventSequence ? checkpoint : null
}

/** Rechecks the SQL batch row's ownership before trusting its durable cursor. */
export function taskGraphSourceStepCheckpoint(value: unknown, expected: TaskGraphSourceStepExpectation): TaskGraphSourceCheckpoint | null {
  const row = object(value)
  return ownedStep(row, expected) ? persistedStepCheckpoint(row) : null
}

/** A current checkpoint is valid only after its exact root Step claimed the accepted inputs. */
export function taskGraphCurrentStepCheckpoint(
  value: unknown, expected: TaskGraphSourceStepExpectation & Readonly<{ attempt: number }>,
): TaskGraphSourceCheckpoint | null {
  const row = object(value)
  if (!ownedStep(row, expected) || row.status !== "streaming"
    || row.hasPendingAcceptedInputs !== false) return null
  return persistedStepCheckpoint(row)
}

/** Loads all causation Steps and the current root Step with one bounded owner-scoped query. */
export async function loadTaskGraphSourceProvenance(
  client: Queryable, scope: GraphScope, loaded: LoadedItem, snapshot: TaskGraphSnapshot, events: readonly unknown[],
  options: TaskGraphSourceLoadOptions = {},
): Promise<TaskGraphSourceProvenance> {
  const checkpoints = new Map(snapshot.nodes.map(node => [node.key, null] as const)) as Map<string, TaskGraphSourceCheckpoint | null>
  const relations = new Map<string, TaskGraphInputRelation>(snapshot.nodes.map(node => [node.key, "unknown"] as const))
  const causes = taskGraphProposalCausationByNodeKey(events, loaded, snapshot, scope)
  const sourceStepIds = [...new Set([...causes.values()].filter((id): id is string => typeof id === "string"))]
  if (sourceStepIds.length > TASK_GRAPH_LIMITS.maxNodes) return { sourceInputCheckpointByNodeKey: checkpoints, sourceInputRelationByNodeKey: relations, currentInputCheckpoint: null }
  const explicitId = text(options.currentStepId) ? options.currentStepId : undefined
  const explicitAttempt = Number.isSafeInteger(options.currentStepAttempt) && Number(options.currentStepAttempt) > 0
    ? Number(options.currentStepAttempt) : undefined
  const discover = options.discoverCurrentStep === true && scope.parentTaskId === scope.rootTaskId
  const currentStepId = explicitId && explicitAttempt ? explicitId : undefined
  if (sourceStepIds.length === 0 && !currentStepId && !discover) {
    return { sourceInputCheckpointByNodeKey: checkpoints, sourceInputRelationByNodeKey: relations, currentInputCheckpoint: null }
  }
  const queryIds = [...new Set([...sourceStepIds, ...(currentStepId ? [currentStepId] : [])])]
  if (queryIds.length + (discover ? 2 : 0) > TASK_GRAPH_SOURCE_STEP_BATCH_LIMIT) {
    return { sourceInputCheckpointByNodeKey: checkpoints, sourceInputRelationByNodeKey: relations, currentInputCheckpoint: null }
  }
  const result = await client.query(`WITH current_candidates AS MATERIALIZED (
      SELECT step."id" FROM "agent_steps" AS step
      WHERE $8::boolean AND step."sessionId" = $2 AND step."turnId" = $3 AND step."taskId" = $4
        AND step."status" = 'streaming' AND step."attempt" = 1
      LIMIT 2
    ), requested_ids AS (
      SELECT unnest($1::text[]) AS "id"
      UNION SELECT "id" FROM current_candidates
      UNION SELECT $7::text WHERE $7::text IS NOT NULL
    ), current_count AS (
      SELECT count(*)::int AS "activeCount" FROM current_candidates
    )
    SELECT step."id", step."sessionId", step."turnId", step."taskId", step."status", step."attempt",
      turn."rootTaskId", session."userId" AS "userId", turn."userId" AS "turnUserId",
      step."inputThroughSequence", step."consumedInputIds", session."eventSequence" AS "sessionEventSequence", current_count."activeCount",
      (candidate."id" IS NOT NULL) AS "isDiscoveredCurrent",
      ($7::text IS NOT NULL AND step."id" = $7::text) AS "isExplicitCurrent",
      CASE WHEN jsonb_typeof(step."consumedInputIds") = 'array' THEN
        CASE WHEN jsonb_array_length(step."consumedInputIds") <= 256 THEN NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(step."consumedInputIds") AS checkpoint_id("value")
          LEFT JOIN "agent_inputs" AS input ON input."id" = checkpoint_id."value"
            AND input."sessionId" = step."sessionId" AND input."targetTurnId" = step."turnId"
            AND input."userId" = session."userId" AND input."delivery" IN ('steer', 'follow_up')
            AND input."status" = 'consumed' AND input."consumedAt" IS NOT NULL AND input."cancelledAt" IS NULL
            AND input."acceptedSequence" <= step."inputThroughSequence"
          WHERE input."id" IS NULL OR input."consumedByStepId" IS DISTINCT FROM step."id" AND (
            input."delivery" <> 'follow_up' OR NOT EXISTS (
              SELECT 1 FROM "agent_steps" AS prior_step
              WHERE prior_step."id" = input."consumedByStepId"
                AND prior_step."sessionId" = step."sessionId" AND prior_step."turnId" = step."turnId"
                AND prior_step."taskId" = step."taskId" AND prior_step."attempt" = 1
                AND prior_step."ordinal" < step."ordinal"
                AND prior_step."inputThroughSequence" >= input."acceptedSequence"
                AND prior_step."inputThroughSequence" <= session."eventSequence"
                AND CASE WHEN jsonb_typeof(prior_step."consumedInputIds") = 'array' THEN
                  CASE WHEN jsonb_array_length(prior_step."consumedInputIds") <= 256 THEN
                    NOT EXISTS (
                      SELECT 1 FROM jsonb_array_elements(prior_step."consumedInputIds") AS prior_id("value")
                      WHERE jsonb_typeof(prior_id."value") <> 'string'
                        OR length(prior_id."value" #>> '{}') = 0 OR length(prior_id."value" #>> '{}') > 256
                        OR btrim(prior_id."value" #>> '{}') <> prior_id."value" #>> '{}'
                    ) AND NOT EXISTS (
                      SELECT prior_id."value" #>> '{}' FROM jsonb_array_elements(prior_step."consumedInputIds") AS prior_id("value")
                      GROUP BY prior_id."value" #>> '{}' HAVING count(*) > 1
                    ) AND EXISTS (
                      SELECT 1 FROM jsonb_array_elements(prior_step."consumedInputIds") AS prior_id("value")
                      WHERE jsonb_typeof(prior_id."value") = 'string' AND prior_id."value" #>> '{}' = input."id"
                    )
                  ELSE false END
                ELSE false END
            )
          )
        ) AND NOT EXISTS (
          SELECT 1 FROM "agent_inputs" AS input
          WHERE input."sessionId" = step."sessionId" AND input."targetTurnId" = step."turnId"
            AND input."userId" = session."userId" AND input."delivery" IN ('steer', 'follow_up')
            AND input."status" = 'consumed' AND input."consumedAt" IS NOT NULL AND input."cancelledAt" IS NULL
            AND input."consumedByStepId" = step."id"
            AND (input."acceptedSequence" > step."inputThroughSequence" OR NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(step."consumedInputIds") AS checkpoint_id("value")
              WHERE checkpoint_id."value" = input."id"
            ))
        ) ELSE false END
      ELSE false END AS "checkpointInputsValid",
      EXISTS (
        SELECT 1 FROM "agent_inputs" AS input
        WHERE input."sessionId" = step."sessionId" AND input."targetTurnId" = step."turnId"
          AND input."userId" = session."userId" AND input."delivery" IN ('steer', 'follow_up')
          AND input."status" IN ('accepted', 'queued')
      ) AS "hasPendingAcceptedInputs"
    FROM requested_ids
    JOIN "agent_steps" AS step ON step."id" = requested_ids."id"
    JOIN "agent_sessions" AS session ON session."id" = step."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = step."turnId" AND turn."sessionId" = step."sessionId"
    CROSS JOIN current_count
    LEFT JOIN current_candidates AS candidate ON candidate."id" = step."id"
    WHERE step."sessionId" = $2 AND step."turnId" = $3 AND step."taskId" = $4
      AND turn."rootTaskId" = $5 AND session."userId" = $6 AND turn."userId" = $6`,
  [queryIds, scope.sessionId, scope.turnId, scope.parentTaskId, scope.rootTaskId, scope.userId, currentStepId ?? null, discover])
  if (result.rows.length > TASK_GRAPH_SOURCE_STEP_BATCH_LIMIT) {
    return { sourceInputCheckpointByNodeKey: checkpoints, sourceInputRelationByNodeKey: relations, currentInputCheckpoint: null }
  }
  const rows = new Map<string, Row>()
  const duplicateRows = new Set<string>()
  for (const raw of result.rows) {
    const row = raw as Row
    if (text(row.id) && !duplicateRows.has(row.id)) {
      if (rows.has(row.id)) { rows.delete(row.id); duplicateRows.add(row.id) }
      else rows.set(row.id, row)
    }
  }
  const expected = (stepId: string): TaskGraphSourceStepExpectation => ({ stepId, attempt: 1, userId: scope.userId, sessionId: scope.sessionId,
    turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId })
  const stepCheckpoints = new Map<string, TaskGraphSourceCheckpoint | null>()
  for (const stepId of sourceStepIds) stepCheckpoints.set(stepId, taskGraphSourceStepCheckpoint(rows.get(stepId), expected(stepId)))
  let currentRow: Row | undefined
  if (currentStepId) {
    const candidate = rows.get(currentStepId)
    if (candidate?.isExplicitCurrent === true) currentRow = candidate
  } else if (discover) {
    const candidates = [...rows.values()].filter(row => row.isDiscoveredCurrent === true)
    if (candidates.length === 1 && candidates[0]?.activeCount === 1) currentRow = candidates[0]
  }
  const currentCheckpoint = currentRow
    ? taskGraphCurrentStepCheckpoint(currentRow, { ...expected(String(currentRow.id)), attempt: explicitAttempt ?? 1 }) : null
  for (const [nodeKey, stepId] of causes) {
    if (!stepId) continue
    const checkpoint = stepCheckpoints.get(stepId) ?? null
    checkpoints.set(nodeKey, checkpoint)
    relations.set(nodeKey, taskGraphInputRelation(checkpoint, currentCheckpoint))
  }
  return { sourceInputCheckpointByNodeKey: checkpoints, sourceInputRelationByNodeKey: relations, currentInputCheckpoint: currentCheckpoint }
}
