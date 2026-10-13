import { Buffer } from "node:buffer"
import type pg from "pg"
import type { TaskGraphReadScope } from "./task-graph-command-port.js"
import {
  NATIVE_VERIFICATION_PACKET_V2_MAX_BYTES,
  NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND,
  NATIVE_VERIFICATION_USER_SELF_ATTESTATION_REFERENCE_PREFIX,
  canonicalNativeVerificationJson,
  digestNativeVerificationValue,
  type NativeVerificationEvidence,
} from "./native-verification-contract.js"
import { parseNativeSteeringTurnInput, parseNativeUserSteeringContent } from "./native-verification-steering-contract.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
const MAX_SEQUENCE = 9_223_372_036_854_775_807n

export const NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_SCHEMA = "native-original-task-reference.v1" as const
export const NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_STAGE = "original_user_task_reference" as const
export const NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_TRUST = "untrusted_user_provided_reference" as const

export type NativeOriginalInputBinding = Readonly<{
  id: string
  clientMessageId: string
  consumedByStepId: string
  acceptedSequence: bigint
  consumedAt: Date
  content: readonly unknown[]
  goal: string | null
}>
export type NativeOriginalInputResolution =
  | Readonly<{ kind: "legacy" }>
  | Readonly<{ kind: "bound"; input: NativeOriginalInputBinding }>
export type NativeOriginalConsumerStep = Readonly<{
  id: string
  ordinal: number
  attempt: number
  inputThroughSequence: bigint
  consumedInputIds: readonly string[]
}>
export type NativeOriginalTaskReferenceProjection =
  | Readonly<{ kind: "omitted" }>
  | Readonly<{ kind: "reference"; content: readonly { readonly type: "text"; readonly text: string }[]; summary: string }>
  | Readonly<{ kind: "unavailable" }>

function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length
    || Object.values(descriptors).some(item => !item.enumerable || !("value" in item))) return null
  return value as Row
}
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim().length > 0 }
function sequence(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n && value <= MAX_SEQUENCE ? value : null
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value)) return null
  const parsed = BigInt(value)
  return parsed <= MAX_SEQUENCE ? parsed : null
}
function date(value: unknown): value is Date { return value instanceof Date && Number.isFinite(value.getTime()) }
function exactKeys(value: Row, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
}

/** Confirms the same current Turn/root owner required by the steering proof. */
export async function nativeOriginalInputOwnerIsCurrent(client: Client, scope: TaskGraphReadScope): Promise<boolean> {
  const result = await client.query<Row>(`SELECT turn."id" AS "turnId", turn."leaseOwnerId", turn."leaseVersion",
      turn."leaseExpiresAt" > clock_timestamp() AS "turnLeaseLive", root."id" AS "rootTaskId",
      root."rootTaskId" AS "taskRootTaskId", root."parentTaskId", root."status" AS "rootStatus",
      root."leaseOwner", root."attemptCount", root."interruptRequestedAt",
      root."leaseExpiresAt" > clock_timestamp() AS "rootLeaseLive"
    FROM "agent_turns" AS turn JOIN "agent_sessions" AS session
      ON session."id" = turn."sessionId" AND session."userId" = turn."userId"
    JOIN "sub_agent_tasks" AS root ON root."id" = turn."rootTaskId" AND root."sessionId" = turn."sessionId"
      AND root."turnId" = turn."id" AND root."rootTaskId" = root."id" AND root."parentTaskId" IS NULL
    WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND turn."rootTaskId" = $4
      AND turn."status" = 'in_progress' AND turn."leaseOwnerId" = $5 AND turn."leaseVersion" = $6
      AND root."status" = 'running' AND root."leaseOwner" = $7 AND root."attemptCount" = $8
      AND root."interruptRequestedAt" IS NULL`,
  [scope.turnId, scope.sessionId, scope.userId, scope.rootTaskId, scope.turnLeaseOwner, scope.turnLeaseVersion,
    scope.parentLeaseOwner, scope.parentAttemptCount])
  const row = result.rows[0]
  return result.rows.length === 1 && row?.turnId === scope.turnId && row.leaseOwnerId === scope.turnLeaseOwner
    && Number(row.leaseVersion) === scope.turnLeaseVersion && row.turnLeaseLive === true
    && row.rootTaskId === scope.rootTaskId && row.taskRootTaskId === scope.rootTaskId && row.parentTaskId === null
    && row.rootStatus === "running" && row.leaseOwner === scope.parentLeaseOwner
    && Number(row.attemptCount) === scope.parentAttemptCount && row.interruptRequestedAt === null && row.rootLeaseLive === true
}

/** Reuses the exact client-message and persisted-content binding; absent legacy fields remain compatible. */
export async function readNativeOriginalInputBinding(
  client: Client, scope: TaskGraphReadScope,
): Promise<NativeOriginalInputResolution | null> {
  const turn = await client.query<Row>(`SELECT "input" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "rootTaskId" = $4`,
    [scope.turnId, scope.sessionId, scope.userId, scope.rootTaskId])
  if (turn.rows.length !== 1) return null
  const envelope = record(turn.rows[0]?.input), nested = record(envelope?.input)
  const canonicalInput = nested && Object.keys(nested).length > 0 ? nested : envelope
  const hasClientMessageId = canonicalInput !== null && Object.hasOwn(canonicalInput, "clientMessageId")
  if (!hasClientMessageId) return { kind: "legacy" }
  const turnInput = parseNativeSteeringTurnInput(turn.rows[0]?.input)
  if (!turnInput) return null
  const matches = await client.query<Row>(`SELECT "id", "sessionId", "userId", "targetTurnId", "clientMessageId", "delivery", "status", "content",
      "acceptedSequence", "consumedByStepId", "consumedAt", "cancelledAt" FROM "agent_inputs"
    WHERE "sessionId" = $1 AND "userId" = $2 AND "targetTurnId" = $3 AND "clientMessageId" = $4 LIMIT 2`,
  [scope.sessionId, scope.userId, scope.turnId, turnInput.clientMessageId])
  if (matches.rows.length !== 1) return null
  const input = record(matches.rows[0]), consumedByStepId = input?.consumedByStepId, acceptedSequence = sequence(input?.acceptedSequence)
  if (!input || !id(input.id) || input.sessionId !== scope.sessionId || input.userId !== scope.userId
    || input.targetTurnId !== scope.turnId || input.clientMessageId !== turnInput.clientMessageId
    || input.delivery !== "follow_up" || input.status !== "consumed" || acceptedSequence === null || !id(consumedByStepId)
    || !date(input.consumedAt) || input.cancelledAt !== null || !Array.isArray(input.content) || input.content.length < 1) return null
  try {
    if (canonicalNativeVerificationJson(input.content) !== canonicalNativeVerificationJson(turnInput.content)) return null
    return { kind: "bound", input: { id: input.id, clientMessageId: input.clientMessageId, consumedByStepId,
      acceptedSequence, consumedAt: input.consumedAt, content: input.content,
      goal: typeof canonicalInput?.goal === "string" ? canonicalInput.goal : null } }
  } catch { return null }
}

/** Projects complete original text as explicitly untrusted reference data; unresolved attachments fail closed. */
export function nativeOriginalTaskReferenceProjection(input: NativeOriginalInputBinding): NativeOriginalTaskReferenceProjection {
  const content = parseNativeUserSteeringContent(input.content)
  if (!content) return { kind: "unavailable" }
  if (input.goal !== null && input.goal.trim() === input.goal && content.length === 1 && content[0]!.text === input.goal) {
    return { kind: "omitted" }
  }
  try {
    const summary = canonicalNativeVerificationJson({ schemaVersion: NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_SCHEMA,
      stage: NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_STAGE, trust: NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_TRUST, content })
    return Buffer.byteLength(summary, "utf8") <= NATIVE_VERIFICATION_PACKET_V2_MAX_BYTES
      ? { kind: "reference", content, summary } : { kind: "unavailable" }
  } catch { return { kind: "unavailable" } }
}

export function nativeOriginalInputStepCoversCheckpoint(
  input: NativeOriginalInputBinding, consumer: NativeOriginalConsumerStep, checkpoint: NativeOriginalConsumerStep,
): boolean {
  return consumer.ordinal === 0 && consumer.attempt === checkpoint.attempt && consumer.consumedInputIds.includes(input.id)
    && input.acceptedSequence <= consumer.inputThroughSequence && consumer.inputThroughSequence <= checkpoint.inputThroughSequence
    && (checkpoint.ordinal !== 0 || consumer.id === checkpoint.id)
}

export function nativeOriginalTaskReferenceEvidence(
  scope: TaskGraphReadScope, input: NativeOriginalInputBinding, consumer: NativeOriginalConsumerStep,
): NativeVerificationEvidence | null {
  const projection = nativeOriginalTaskReferenceProjection(input)
  if (projection.kind !== "reference") return null
  try {
    const identity = { owner: { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId },
      input: { id: input.id, clientMessageId: input.clientMessageId, acceptedSequence: input.acceptedSequence.toString(),
        consumedByStepId: input.consumedByStepId, consumedAt: input.consumedAt.toISOString(), content: projection.content },
      consumingStep: { id: consumer.id, ordinal: consumer.ordinal, attempt: consumer.attempt,
        inputThroughSequence: consumer.inputThroughSequence.toString(), consumedInputIds: consumer.consumedInputIds } }
    return { referenceId: NATIVE_VERIFICATION_USER_SELF_ATTESTATION_REFERENCE_PREFIX + digestNativeVerificationValue(identity),
      kind: NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND, summary: projection.summary }
  } catch { return null }
}

export function isNativeOriginalTaskReferenceEvidence(value: unknown): value is NativeVerificationEvidence {
  const evidence = record(value)
  if (!evidence || !exactKeys(evidence, ["referenceId", "kind", "summary"])
    || evidence.kind !== NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND
    || typeof evidence.referenceId !== "string"
    || !new RegExp(`^${NATIVE_VERIFICATION_USER_SELF_ATTESTATION_REFERENCE_PREFIX}[a-f0-9]{64}$`).test(evidence.referenceId)
    || typeof evidence.summary !== "string" || Buffer.byteLength(evidence.summary, "utf8") > NATIVE_VERIFICATION_PACKET_V2_MAX_BYTES) return false
  try {
    const parsed = record(JSON.parse(evidence.summary)), parts = parseNativeUserSteeringContent(parsed?.content)
    return parsed !== null && exactKeys(parsed, ["schemaVersion", "stage", "trust", "content"])
      && parsed.schemaVersion === NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_SCHEMA
      && parsed.stage === NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_STAGE
      && parsed.trust === NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_TRUST && parts !== null
      && canonicalNativeVerificationJson({ schemaVersion: NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_SCHEMA,
        stage: NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_STAGE, trust: NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_TRUST,
        content: parts }) === evidence.summary
  } catch { return false }
}
