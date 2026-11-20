import type pg from "pg"
import { readScheduledPipelineRecoveryStepProfile, SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY } from "./subagents/scheduled-pipeline-recovery-step.js"

type Row = Record<string, unknown>
type Client = Pick<pg.PoolClient, "query">
type Scope = Readonly<{ userId: string; sessionId: string; turnId: string; rootTaskId: string }>
type Input = Readonly<{ step: Row; items: readonly Row[]; events: readonly Row[]; waits: readonly Row[]; scope: Scope }>
const WAIT_KEYS = ["consumedAt", "id", "matchedTaskIds", "mode", "parentTaskId", "sessionId", "status", "stepId", "suspendedAt", "targetTaskIds", "turnId", "userId"]

function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const prototype = Object.getPrototypeOf(parsed)
  return prototype === Object.prototype || prototype === null ? parsed as Row : null
}
function invalid(): never { throw new Error("archived_wait_accounting_invalid") }
function ownsMarker(value: unknown): boolean { return Object.hasOwn(object(value) ?? {}, SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY) }
function exactKeys(value: Row, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value)
  return (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key))
    && keys.every(key => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return !!descriptor?.enumerable && Object.hasOwn(descriptor, "value") })
}
function eventMatches(event: Row, type: string, scope: Scope, stepId: string): boolean {
  return event.type === type && event.actor === "orchestrator" && event.userId === scope.userId && event.sessionId === scope.sessionId
    && event.turnId === scope.turnId && event.taskId === scope.rootTaskId && event.itemId === null && event.correlationId === stepId
    && event.idempotencyKey === `turn:${scope.turnId}:event:${type === "step.started" ? "step-started" : "step-completed"}:${stepId}`
    && typeof event.id === "string" && event.id.length > 0
}
function date(value: unknown): boolean { return value instanceof Date && Number.isFinite(value.getTime()) }
function ids(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8 || !value.every(id => typeof id === "string" && id.length > 0 && id.trim() === id)
    || new Set(value).size !== value.length) return null
  return value as string[]
}

/** Loads only wait rows named by server recovery Steps, under their exact persisted owner. */
export async function readScheduledRecoveryWaitRows(client: Client, input: Readonly<{
  scope: Scope; steps: readonly Row[]; events: readonly Row[]
}>): Promise<readonly Row[]> {
  const waitIds = new Set<string>()
  for (const step of input.steps) {
    if (step.status !== "waiting_for_tool" || !ownsMarker(step.modelProfileSnapshot)) continue
    const marker = readScheduledPipelineRecoveryStepProfile(step.modelProfileSnapshot)
    if (!marker || typeof step.id !== "string" || marker.recoveryStepId !== step.id) invalid()
    const completion = input.events.filter(event => event.type === "step.completed" && event.correlationId === step.id)
    if (completion.length !== 1) continue
    const payload = object(completion[0]?.payload)
    if (!payload || typeof payload.waitId !== "string" || !payload.waitId.trim() || payload.waitId.length > 256) continue
    waitIds.add(payload.waitId)
  }
  if (!waitIds.size) return []
  const result = await client.query<Row>(`SELECT "id", "userId", "sessionId", "turnId", "parentTaskId", "stepId", "status", "targetTaskIds",
      "matchedTaskIds", "mode", "suspendedAt", "consumedAt" FROM "agent_wait_conditions"
    WHERE "id" = ANY($1::text[]) AND "userId" = $2 AND "sessionId" = $3 AND "turnId" = $4 AND "parentTaskId" = $5 FOR SHARE`,
  [[...waitIds], input.scope.userId, input.scope.sessionId, input.scope.turnId, input.scope.rootTaskId])
  return result.rows
}

/** Distinguishes a validated model-free recovery wait from ordinary archived tool batches. */
export function isScheduledRecoveryOperationalWait(input: Input): boolean {
  const { step, scope } = input
  if (!ownsMarker(step.modelProfileSnapshot)) return false
  const stepId = step.id, marker = readScheduledPipelineRecoveryStepProfile(step.modelProfileSnapshot)
  if (!marker || typeof stepId !== "string" || marker.recoveryStepId !== stepId || marker.owner.userId !== scope.userId
    || marker.owner.sessionId !== scope.sessionId || marker.owner.turnId !== scope.turnId || marker.owner.rootTaskId !== scope.rootTaskId
    || step.taskId !== scope.rootTaskId || step.status !== "waiting_for_tool" || Number(step.attempt) !== 1
    || !Number.isSafeInteger(step.ordinal) || Number(step.ordinal) <= marker.sourceStepOrdinal
    || String(step.inputThroughSequence) !== marker.inputThroughSequence || Number(step.inputTokens) !== 0
    || Number(step.outputTokens) !== 0 || Number(step.estimatedCostUsd) !== 0 || step.errorCode !== null) return invalid()
  const related = input.events.filter(event => event.correlationId === stepId)
  const starts = related.filter(event => event.type === "step.started"), completes = related.filter(event => event.type === "step.completed")
  const modelActivity = related.some(event => typeof event.type === "string" && event.type.startsWith("model."))
  const items = input.items.filter(item => item.stepId === stepId && (item.type === "tool_call" || item.type === "tool_result"))
  if (modelActivity || items.length || starts.length !== 1 || completes.length !== 1
    || !eventMatches(starts[0]!, "step.started", scope, stepId) || !eventMatches(completes[0]!, "step.completed", scope, stepId)) return invalid()
  const start = object(starts[0]!.payload), completion = object(completes[0]!.payload)
  const startKeys = ["ordinal", "stepId", "taskId", SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY]
  if (!start || !exactKeys(start, startKeys) || start.stepId !== stepId || Number(start.ordinal) !== Number(step.ordinal)
    || start.taskId !== scope.rootTaskId || JSON.stringify(readScheduledPipelineRecoveryStepProfile({
      [SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY]: start[SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY],
    })) !== JSON.stringify(marker) || !completion || !exactKeys(completion, ["stepId", "status", "taskId", "waitId"])
    || completion.stepId !== stepId || completion.status !== "waiting_for_dependency" || completion.taskId !== scope.rootTaskId
    || typeof completion.waitId !== "string" || !completion.waitId.trim()) return invalid()
  const matching = input.waits.filter(wait => wait.id === completion.waitId)
  if (matching.length !== 1) return invalid()
  const wait = matching[0]!, targets = ids(wait.targetTaskIds), matched = ids(wait.matchedTaskIds)
  if (!exactKeys(wait, WAIT_KEYS) || wait.userId !== scope.userId || wait.sessionId !== scope.sessionId || wait.turnId !== scope.turnId
    || wait.parentTaskId !== scope.rootTaskId || wait.stepId !== stepId || wait.status !== "ready" || wait.mode !== "all" && wait.mode !== "any"
    || !date(wait.suspendedAt) || !date(wait.consumedAt) || !targets || !matched || matched.some(id => !targets.includes(id))
    || matched.length === 0 || wait.mode === "all" && matched.length !== targets.length) return invalid()
  return true
}
