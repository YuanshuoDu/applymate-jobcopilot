import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import type pg from "pg"
import type { TurnLease } from "../turns/lease.js"
import { lockTaskGraphScope, type GraphScope } from "../subagents/task-graph-pg-state.js"
import { digestNativeVerificationValue } from "../subagents/native-verification-contract.js"
import { isScheduledAutomationTurn, scheduledAutomationCriteria, type ScheduledAutomationCriteria } from "../subagents/scheduled-automation-snapshot.js"
import { resolveRootTaskObjective, resolveRootTaskVerificationRequirements } from "./root-task-objective.js"
import { readRootTaskHistoryChronologyWitness, type RootTaskHistoryChronologyWitness } from "./root-task-history-chronology-witness.js"

type Client = pg.PoolClient
type Row = Record<string, unknown>

export type RootTaskHistoryFenceInput = Readonly<{
  lease: TurnLease
  rootTaskId: string
  rootAttemptCount: number
  stepId: string
  now: Date
  crossSessionRootTaskHistoryEnabled?: boolean
  objectiveHistoryIndexEnabled?: boolean
}>

export type RootTaskHistoryFence = Readonly<{
  currentStartSequence: bigint
  currentStartWitness?: RootTaskHistoryChronologyWitness
  objectiveDigest: string
  scheduledAutomationCriteria?: ScheduledAutomationCriteria
  objectiveHistoryIndexObjectiveDigest?: string
  objectiveHistoryIndexCanonicalOriginDigest?: string
  currentOrigin?: string
}>

type Queryable = Pick<pg.PoolClient, "query">

function text(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.trim() === value
}

function object(value: unknown): Row | null {
  let parsed = value
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed) as unknown } catch { return null }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try {
    const prototype = Object.getPrototypeOf(parsed)
    return prototype === Object.prototype || prototype === null ? parsed as Row : null
  } catch { return null }
}

function sequence(value: unknown): bigint | undefined {
  if (typeof value !== "string" && typeof value !== "bigint") return undefined
  try { const parsed = BigInt(value); return parsed > 0n ? parsed : undefined } catch { return undefined }
}

export function hasSelectedJobPreparation(turnInput: unknown): boolean {
  const input = object(turnInput)
  if (!input) return false
  if (Object.hasOwn(input, "selectedJobPreparation")) return true
  const nested = object(input.input)
  return Boolean(nested && Object.keys(nested).length > 0 && Object.hasOwn(nested, "selectedJobPreparation"))
}

/** Encodes only a validated persisted Turn source and its narrow origin discriminator. */
export function rootTaskHistoryOrigin(source: unknown, turnInput: unknown): string | undefined {
  if (!text(source)) return undefined
  const envelope = object(turnInput)
  if (!envelope) return undefined
  const hasNested = Object.hasOwn(envelope, "input"), nested = hasNested ? object(envelope.input) : null
  if (hasNested && !nested) return undefined
  const copies = [envelope, ...(nested ? [nested] : [])]
    .filter(value => Object.hasOwn(value, "intent"))
  if (!copies.length) return JSON.stringify([source, "none"])
  for (const copy of copies) {
    const intent = object(copy.intent)
    if (!intent || Object.keys(intent).sort().join(",") !== "kind,version"
      || intent.kind !== "interactive_discovery_shortlist" || intent.version !== 1) return undefined
  }
  return JSON.stringify([source, "interactive_discovery_shortlist", 1])
}

export function validateRootTaskHistoryFenceInput(input: RootTaskHistoryFenceInput): void {
  const { lease } = input
  if (!text(lease.userId) || !text(lease.sessionId) || !text(lease.turnId) || !text(lease.ownerId)
    || !Number.isSafeInteger(lease.leaseVersion) || lease.leaseVersion < 1 || !text(input.rootTaskId)
    || !Number.isSafeInteger(input.rootAttemptCount) || input.rootAttemptCount < 1 || !text(input.stepId)
    || (input.crossSessionRootTaskHistoryEnabled !== undefined && typeof input.crossSessionRootTaskHistoryEnabled !== "boolean")
    || (input.objectiveHistoryIndexEnabled !== undefined && typeof input.objectiveHistoryIndexEnabled !== "boolean")
    || !(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new Error("root_task_history_input_invalid")
  }
}

function validRoot(row: Row, input: RootTaskHistoryFenceInput): boolean {
  return row.id === input.rootTaskId && row.userId === input.lease.userId
    && row.sessionId === input.lease.sessionId && row.turnId === input.lease.turnId
    && row.rootTaskId === input.rootTaskId && row.parentTaskId === null
    && row.role === "orchestrator" && row.taskType === "root" && row.status === "running"
    && row.leaseOwner === input.lease.ownerId && Number(row.attemptCount) === input.rootAttemptCount
    && row.interruptRequestedAt == null
}

/** Every history identity includes typed requirements; the optional mode flag remains source-compatible. */
export function rootTaskHistoryObjectiveDigest(turnInput: unknown, root: Row, _includeVerificationRequirements?: boolean): string | undefined {
  const resolved = resolveRootTaskObjective(turnInput, { goal: root.goal, successCriteria: root.successCriteria })
  if (!resolved.goal || resolved.turnGoalConflict || !resolved.criteriaValid || !resolved.criteria.length
    || resolved.criteria.some(requirement => Buffer.byteLength(requirement, "utf8") > 2_000)) return undefined
  const criteria = resolved.criteria.map((requirement, index) => ({
    criterionId: `criterion-${index + 1}`, requirement,
  }))
  const requirements = resolveRootTaskVerificationRequirements(turnInput)
  if (requirements.status === "invalid") return undefined
  const verificationRequirements = requirements.status === "valid"
    ? [...requirements.requirements]
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      .map(({ id, kind, minimum }) => ({ id, kind, minimum }))
    : null
  return digestNativeVerificationValue({
    goal: resolved.goal, criteria,
    verificationRequirements,
  })
}

/** Derives projection lookup keys from persisted Turn and Root data; projection fields remain locators only. */
export function rootTaskHistoryIndexKeys(
  source: unknown,
  turnInput: unknown,
  root: Row,
  includeCrossSession: boolean,
): Readonly<{ objectiveDigest: string; canonicalOriginDigest?: string }> | undefined {
  const objectiveDigest = rootTaskHistoryObjectiveDigest(turnInput, root)
  if (!objectiveDigest) return undefined
  if (!includeCrossSession) return { objectiveDigest }
  const canonicalOrigin = rootTaskHistoryOrigin(source, turnInput)
  if (!canonicalOrigin) return undefined
  return {
    objectiveDigest,
    canonicalOriginDigest: createHash("sha256")
      .update(JSON.stringify({ objectiveDigest, canonicalOrigin }))
      .digest("hex"),
  }
}

async function currentStart(client: Queryable, input: RootTaskHistoryFenceInput): Promise<Readonly<{ eventId: string; sequence: bigint }> | undefined> {
  const { lease } = input
  const result = await client.query<Row>(`SELECT event."id", event."sessionId", event."turnId", event."taskId", event."itemId", event."sequence",
      event."type", event."actor", event."correlationId", event."idempotencyKey", event."payload",
      COUNT(*) OVER () AS "startEventCount"
    FROM "agent_events" AS event
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."taskId" = $3
      AND event."type" = 'turn.started' AND turn."rootTaskId" = $3
      AND turn."userId" = $4 AND session."userId" = $4`,
  [lease.sessionId, lease.turnId, input.rootTaskId, lease.userId])
  if (result.rows.length !== 1 || Number(result.rows[0]?.startEventCount) !== 1) return undefined
  const row = result.rows[0]!, payload = object(row.payload), value = sequence(row.sequence)
  return text(row.id) && row.sessionId === lease.sessionId && row.turnId === lease.turnId && row.taskId === input.rootTaskId
    && row.itemId === null && row.type === "turn.started" && row.actor === "orchestrator"
    && row.correlationId === lease.turnId && row.idempotencyKey === `turn:${lease.turnId}:event:turn-started`
    && payload?.taskId === input.rootTaskId && payload.rootTaskId === input.rootTaskId && value
    ? { eventId: row.id, sequence: value } : undefined
}

/** Locks and validates the live ordinary Root, its current Step, Turn lease, objective, and unique start receipt. */
export async function readRootTaskHistoryFence(
  client: Client,
  input: RootTaskHistoryFenceInput,
): Promise<RootTaskHistoryFence | undefined> {
  const { lease } = input
  const scope: Omit<GraphScope, "stepId"> = {
    userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: input.rootTaskId,
    parentTaskId: input.rootTaskId, turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion,
    parentLeaseOwner: lease.ownerId, parentAttemptCount: input.rootAttemptCount,
  }
  const root = await lockTaskGraphScope(client, { ...scope, stepId: input.stepId }, false)
  if (!validRoot(root, input)) throw new Error("root_task_history_current_root_fenced")

  const step = await client.query<Row>(`SELECT "id", "sessionId", "turnId", "taskId", "attempt", "status"
    FROM "agent_steps" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 FOR UPDATE`,
  [input.stepId, lease.sessionId, lease.turnId])
  const currentStep = step.rows[0]
  if (step.rows.length !== 1 || !currentStep || currentStep.taskId !== input.rootTaskId
    || Number(currentStep.attempt) !== 1 || currentStep.status !== "streaming") {
    throw new Error("root_task_history_current_step_fenced")
  }

  const turn = await client.query<Row>(`SELECT "id", "sessionId", "userId", "rootTaskId", "status", "source", "input"
    FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "rootTaskId" = $4
      AND "leaseOwnerId" = $5 AND "leaseVersion" = $6 AND "status" = 'in_progress' FOR UPDATE`,
  [lease.turnId, lease.sessionId, lease.userId, input.rootTaskId, lease.ownerId, lease.leaseVersion])
  const currentTurn = turn.rows[0]
  if (turn.rows.length !== 1 || !currentTurn) throw new Error("root_task_history_current_turn_fenced")
  if (hasSelectedJobPreparation(currentTurn.input)) return undefined
  const scheduledTurn = isScheduledAutomationTurn(currentTurn.source, currentTurn.input)
  const scheduledCriteria = scheduledTurn ? scheduledAutomationCriteria(currentTurn.input) : undefined
  if (scheduledTurn && !scheduledCriteria) return undefined
  const currentOrigin = input.crossSessionRootTaskHistoryEnabled ? rootTaskHistoryOrigin(currentTurn.source, currentTurn.input) : undefined
  const objectiveDigest = rootTaskHistoryObjectiveDigest(currentTurn.input, root)
  if (!objectiveDigest) return undefined
  const indexKeys = input.objectiveHistoryIndexEnabled === true
    ? rootTaskHistoryIndexKeys(currentTurn.source, currentTurn.input, root,
      input.crossSessionRootTaskHistoryEnabled === true && currentOrigin !== undefined)
    : undefined
  if (input.objectiveHistoryIndexEnabled === true && !indexKeys) return undefined
  const start = await currentStart(client, input)
  if (!start) return undefined
  const currentStartWitness = input.crossSessionRootTaskHistoryEnabled === true && currentOrigin
    ? await readRootTaskHistoryChronologyWitness(client, { boundaryEventId: start.eventId, boundary: "turn_start",
      userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: input.rootTaskId })
    : undefined
  return {
    currentStartSequence: start.sequence, objectiveDigest,
    ...(currentStartWitness ? { currentStartWitness } : {}),
    ...(scheduledCriteria ? { scheduledAutomationCriteria: scheduledCriteria } : {}),
    ...(indexKeys ? { objectiveHistoryIndexObjectiveDigest: indexKeys.objectiveDigest,
      ...(indexKeys.canonicalOriginDigest ? { objectiveHistoryIndexCanonicalOriginDigest: indexKeys.canonicalOriginDigest } : {}) } : {}),
    ...(currentOrigin ? { currentOrigin } : {}),
  }
}

export async function withRootTaskHistoryTransaction<T>(
  pool: Pick<pg.Pool, "connect">,
  userId: string,
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", userId])
    const result = await work(client)
    await client.query("COMMIT")
    committed = true
    return result
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}
