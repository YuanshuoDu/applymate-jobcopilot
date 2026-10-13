import type pg from "pg"
import { Buffer } from "node:buffer"
import type { TaskGraphReadScope } from "./task-graph-command-port.js"
import {
  NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND,
  NATIVE_VERIFICATION_USER_SELF_ATTESTATION_REFERENCE_PREFIX,
  canonicalNativeVerificationJson,
  digestNativeVerificationValue,
  type NativeVerificationEvidence,
} from "./native-verification-contract.js"
import {
  nativeOriginalInputOwnerIsCurrent,
  nativeOriginalInputStepCoversCheckpoint,
  nativeOriginalTaskReferenceEvidence,
  nativeOriginalTaskReferenceProjection,
  readNativeOriginalInputBinding,
  type NativeOriginalInputBinding,
} from "./native-verification-original-input-source.js"
import {
  NATIVE_VERIFICATION_USER_STEERING_MAX_INPUTS,
  NATIVE_VERIFICATION_USER_STEERING_MAX_SOURCE_BYTES,
  NATIVE_VERIFICATION_USER_STEERING_MAX_TOTAL_BYTES,
  NATIVE_VERIFICATION_USER_STEERING_SCHEMA,
  NATIVE_VERIFICATION_USER_STEERING_STAGE,
  nativeSteeringCheckpointInputIdsMatch,
  parseNativeUserSteeringContent,
} from "./native-verification-steering-contract.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
const MAX_SEQUENCE = 9_223_372_036_854_775_807n
const MAX_STEP_INPUTS = 256
const USABLE_STEP_STATUS = new Set(["streaming", "completed"])
const RECOVERY_STEP_STATUS = new Set(["streaming", "waiting_for_tool", "waiting_for_approval", "waiting_for_user", "completed", "failed", "interrupted"])
const SOURCE_STEP_STATUS = new Set(["streaming", "waiting_for_tool", "waiting_for_approval", "waiting_for_user", "completed", "failed", "interrupted"])
export type NativeSteeringCheckpointSelection =
  | Readonly<{ kind: "exact"; stepId?: string }>
  | Readonly<{ kind: "latest" }>
type Step = Readonly<{ id: string; taskId: string; ordinal: number; attempt: number; status: string; inputThroughSequence: bigint; consumedInputIds: readonly string[] }>
type Source = Readonly<{ id: string; userId: string; sessionId: string; targetTurnId: string; delivery: string; status: string; content: unknown; acceptedSequence: bigint; consumedByStepId: string | null;
  consumedAt: Date | null; cancelledAt: Date | null }>
function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length) return null
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(item => item.enumerable && "value" in item)
    ? value as Row : null
}
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim().length > 0 }
function sequence(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n && value <= MAX_SEQUENCE ? value : null
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value)) return null
  const parsed = BigInt(value)
  return parsed <= MAX_SEQUENCE ? parsed : null
}
function ids(value: unknown): string[] | null {
  let entries = value
  if (typeof entries === "string") { try { entries = JSON.parse(entries) } catch { return null } }
  if (!Array.isArray(entries) || Object.getPrototypeOf(entries) !== Array.prototype || entries.length > MAX_STEP_INPUTS
    || Object.getOwnPropertySymbols(entries).length || Object.getOwnPropertyNames(entries).length !== entries.length + 1) return null
  const result: string[] = []
  for (let index = 0; index < entries.length; index += 1) {
    if (!Object.hasOwn(entries, index) || !id(entries[index]) || result.includes(entries[index] as string)) return null
    result.push(entries[index] as string)
  }
  return result
}
function parsedJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) as unknown } catch { return null }
}
function date(value: unknown): value is Date { return value instanceof Date && Number.isFinite(value.getTime()) }
function step(value: unknown): Step | null {
  const row = record(value), cursor = sequence(row?.inputThroughSequence), consumed = ids(row?.consumedInputIds)
  if (!row || !id(row.id) || !id(row.taskId) || !Number.isSafeInteger(row.ordinal) || Number(row.ordinal) < 0
    || !Number.isSafeInteger(row.attempt) || Number(row.attempt) < 1 || typeof row.status !== "string"
    || cursor === null || consumed === null) return null
  return { id: row.id, taskId: row.taskId, ordinal: Number(row.ordinal), attempt: Number(row.attempt), status: row.status,
    inputThroughSequence: cursor, consumedInputIds: consumed }
}
function source(value: unknown): Source | null {
  const row = record(value), acceptedSequence = sequence(row?.acceptedSequence)
  if (!row || !id(row.id) || !id(row.userId) || !id(row.sessionId) || !id(row.targetTurnId)
    || typeof row.delivery !== "string" || typeof row.status !== "string" || acceptedSequence === null
    || !(row.consumedByStepId === null || id(row.consumedByStepId))
    || !(row.consumedAt === null || date(row.consumedAt)) || !(row.cancelledAt === null || date(row.cancelledAt))) return null
  return { id: row.id, userId: row.userId, sessionId: row.sessionId, targetTurnId: row.targetTurnId,
    delivery: row.delivery, status: row.status, content: parsedJson(row.content), acceptedSequence,
    consumedByStepId: row.consumedByStepId, consumedAt: row.consumedAt, cancelledAt: row.cancelledAt }
}
function compareStep(left: Step, right: Step): number { return left.ordinal - right.ordinal || left.attempt - right.attempt }
async function selectStep(client: Client, scope: TaskGraphReadScope, selection: NativeSteeringCheckpointSelection): Promise<Step | null> {
  const base = `FROM "agent_steps" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3`
  const values = [scope.sessionId, scope.turnId, scope.rootTaskId]
  if (selection.kind === "exact") {
    if (selection.stepId === undefined || !id(selection.stepId)) return null
    const result = await client.query<Row>(`SELECT step."id", step."taskId", step."ordinal", step."attempt", step."status",
        step."inputThroughSequence", step."consumedInputIds" FROM "agent_steps" AS step
      WHERE step."id" = $4 AND step."sessionId" = $1 AND step."turnId" = $2 AND step."taskId" = $3
        AND step."attempt" = $5
        AND NOT EXISTS (SELECT 1 FROM "agent_steps" AS newer WHERE newer."sessionId" = step."sessionId"
          AND newer."turnId" = step."turnId" AND newer."taskId" = step."taskId"
          AND newer."attempt" = $5
          AND (newer."ordinal" > step."ordinal" OR (newer."ordinal" = step."ordinal" AND newer."attempt" > step."attempt")))`,
    [...values, selection.stepId, scope.parentAttemptCount])
    return result.rows.length === 1 ? step(result.rows[0]) : null
  }
  if (selection.kind !== "latest") return null
  const result = await client.query<Row>(`SELECT "id", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds"
    ${base} AND "attempt" = $4 ORDER BY "ordinal" DESC, "attempt" DESC, "id" DESC LIMIT 2`,
  [...values, scope.parentAttemptCount])
  const selected = step(result.rows[0])
  if (!selected) return null
  const second = result.rows[1] ? step(result.rows[1]) : null
  return second && compareStep(selected, second) === 0 ? null : selected
}

async function steeringRows(client: Client, scope: TaskGraphReadScope, cutoff: bigint | null, originalId: string | null, currentStepId?: string): Promise<Source[] | null> {
  const result = await client.query<Row>(`SELECT "id", "userId", "sessionId", "targetTurnId", "delivery", "status", "content",
      "acceptedSequence", "consumedByStepId", "consumedAt", "cancelledAt" FROM "agent_inputs"
    WHERE "sessionId" = $1 AND "userId" = $2 AND "targetTurnId" = $3 AND "delivery" = 'steer'
      AND ($4::bigint IS NULL OR "acceptedSequence" <= $4::bigint OR "consumedByStepId" = $6) AND ($5::text IS NULL OR "id" <> $5)
      AND ("status" = 'consumed' OR "consumedByStepId" IS NOT NULL OR "consumedAt" IS NOT NULL)
    ORDER BY "acceptedSequence" ASC, "id" ASC LIMIT $7`,
  [scope.sessionId, scope.userId, scope.turnId, cutoff?.toString() ?? null, originalId, currentStepId ?? null, NATIVE_VERIFICATION_USER_STEERING_MAX_INPUTS + 1])
  if (result.rows.length > NATIVE_VERIFICATION_USER_STEERING_MAX_INPUTS) return null
  const parsed = result.rows.map(source)
  return parsed.some(item => item === null) ? null : parsed as Source[]
}

async function sourceSteps(client: Client, scope: TaskGraphReadScope, inputs: readonly Source[], original: NativeOriginalInputBinding | null, checkpoint: Step): Promise<Map<string, Step> | null> {
  const stepIds = [...new Set(inputs.map(input => input.consumedByStepId).filter((value): value is string => value !== null))]
  if (stepIds.length !== new Set(inputs.map(input => input.consumedByStepId)).size) return null
  if (original && !stepIds.includes(original.consumedByStepId)) stepIds.push(original.consumedByStepId)
  const result = stepIds.length === 0 ? { rows: [] as Row[] } : await client.query<Row>(`SELECT "id", "taskId", "ordinal", "attempt", "status",
      "inputThroughSequence", "consumedInputIds" FROM "agent_steps"
    WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "id" = ANY($4::text[])`,
  [scope.sessionId, scope.turnId, scope.rootTaskId, stepIds])
  if (result.rows.length !== stepIds.length) return null
  const values = result.rows.map(step)
  if (values.some(item => item === null || item.taskId !== scope.rootTaskId)) return null
  const map = new Map((values as Step[]).map(item => [item.id, item]))
  const originalStep = original ? map.get(original.consumedByStepId) : null
  if (original && (!originalStep || !SOURCE_STEP_STATUS.has(originalStep.status)
    || !nativeOriginalInputStepCoversCheckpoint(original, originalStep, checkpoint))) return null
  return map.size === stepIds.length ? map : null
}

function evidence(scope: TaskGraphReadScope, input: Source, consumedStep: Step): NativeVerificationEvidence | null {
  if (input.userId !== scope.userId || input.sessionId !== scope.sessionId || input.targetTurnId !== scope.turnId
    || input.delivery !== "steer" || input.status !== "consumed" || input.cancelledAt !== null
    || !input.consumedByStepId || !date(input.consumedAt)) return null
  const content = parseNativeUserSteeringContent(input.content)
  if (!content) return null
  try {
    const summary = canonicalNativeVerificationJson({ schemaVersion: NATIVE_VERIFICATION_USER_STEERING_SCHEMA,
      stage: NATIVE_VERIFICATION_USER_STEERING_STAGE, content })
    if (Buffer.byteLength(summary, "utf8") > NATIVE_VERIFICATION_USER_STEERING_MAX_SOURCE_BYTES) return null
    const identity = { owner: { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId },
      input: { id: input.id, acceptedSequence: input.acceptedSequence.toString(), consumedByStepId: input.consumedByStepId,
        consumedAt: input.consumedAt.toISOString(), content },
      consumingStep: { id: consumedStep.id, ordinal: consumedStep.ordinal, attempt: consumedStep.attempt,
        inputThroughSequence: consumedStep.inputThroughSequence.toString(), consumedInputIds: consumedStep.consumedInputIds } }
    return { referenceId: NATIVE_VERIFICATION_USER_SELF_ATTESTATION_REFERENCE_PREFIX + digestNativeVerificationValue(identity),
      kind: NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND, summary }
  } catch { return null }
}

export type NativeVerificationUserReferenceSources = Readonly<{
  originalTaskReference: readonly NativeVerificationEvidence[]
  originalTaskReferenceRequired: boolean
  steering: readonly NativeVerificationEvidence[]
}>

export async function readNativeVerificationUserReferenceSources(
  client: Client, scope: TaskGraphReadScope, selection: NativeSteeringCheckpointSelection,
): Promise<NativeVerificationUserReferenceSources | null> {
  if (!id(scope.userId) || !id(scope.sessionId) || !id(scope.turnId) || !id(scope.rootTaskId)
    || !id(scope.parentTaskId) || !id(scope.turnLeaseOwner) || !id(scope.parentLeaseOwner)
    || scope.parentTaskId !== scope.rootTaskId || !Number.isSafeInteger(scope.turnLeaseVersion) || scope.turnLeaseVersion < 1
    || !Number.isSafeInteger(scope.parentAttemptCount) || scope.parentAttemptCount < 1) return null
  if (!await nativeOriginalInputOwnerIsCurrent(client, scope)) return null
  const resolution = await readNativeOriginalInputBinding(client, scope)
  if (!resolution) return null
  const original = resolution.kind === "bound" ? resolution.input : null
  const originalId = original?.id ?? null
  const originalProjection = original ? nativeOriginalTaskReferenceProjection(original) : null
  if (originalProjection?.kind === "unavailable") return null
  if (selection.kind === "exact" && selection.stepId === undefined) {
    const found = await steeringRows(client, scope, null, originalId)
    if (found?.length !== 0) return null
    return { steering: [], originalTaskReference: [],
      originalTaskReferenceRequired: originalProjection?.kind === "reference" }
  }
  const checkpoint = await selectStep(client, scope, selection)
  const usable = selection.kind === "latest" ? RECOVERY_STEP_STATUS : USABLE_STEP_STATUS
  if (!checkpoint || checkpoint.taskId !== scope.rootTaskId || checkpoint.attempt !== scope.parentAttemptCount
    || !usable.has(checkpoint.status)) return null
  const inputs = await steeringRows(client, scope, checkpoint.inputThroughSequence, originalId, checkpoint.id)
  if (!inputs || (original && original.acceptedSequence > checkpoint.inputThroughSequence)) return null
  if (originalId === null && inputs.length > 0) return null
  const currentStepInputs = inputs.filter(input => input.consumedByStepId === checkpoint.id).map(input => input.id)
  const currentStepOriginalId = original?.consumedByStepId === checkpoint.id ? original.id : null
  if (!nativeSteeringCheckpointInputIdsMatch(checkpoint.consumedInputIds, currentStepOriginalId, currentStepInputs)) return null
  if (inputs.some(input => input.acceptedSequence > checkpoint.inputThroughSequence)) return null
  const sourceStepMap = await sourceSteps(client, scope, inputs, original, checkpoint)
  if (!sourceStepMap) return null
  let totalBytes = 0
  const result: NativeVerificationEvidence[] = []
  for (const input of inputs) {
    const consumedStep = input.consumedByStepId ? sourceStepMap.get(input.consumedByStepId) : undefined
    if (!consumedStep || consumedStep.taskId !== scope.rootTaskId || !SOURCE_STEP_STATUS.has(consumedStep.status)
      || !consumedStep.consumedInputIds.includes(input.id) || input.acceptedSequence > consumedStep.inputThroughSequence
      || compareStep(consumedStep, checkpoint) > 0) return null
    const item = evidence(scope, input, consumedStep)
    if (!item) return null
    totalBytes += Buffer.byteLength(item.summary, "utf8")
    if (totalBytes > NATIVE_VERIFICATION_USER_STEERING_MAX_TOTAL_BYTES) return null
    result.push(item)
  }
  let originalTaskReference: readonly NativeVerificationEvidence[] = []
  if (original && originalProjection?.kind === "reference") {
    const consumer = sourceStepMap.get(original.consumedByStepId)
    if (!consumer || !nativeOriginalInputStepCoversCheckpoint(original, consumer, checkpoint)) return null
    const item = nativeOriginalTaskReferenceEvidence(scope, original, consumer)
    if (!item) return null
    originalTaskReference = [item]
  }
  return { steering: result, originalTaskReference, originalTaskReferenceRequired: false }
}

export async function readNativeVerificationSteeringSource(
  client: Client, scope: TaskGraphReadScope, selection: NativeSteeringCheckpointSelection,
): Promise<readonly NativeVerificationEvidence[] | null> {
  const sources = await readNativeVerificationUserReferenceSources(client, scope, selection)
  return sources?.steering ?? null
}
