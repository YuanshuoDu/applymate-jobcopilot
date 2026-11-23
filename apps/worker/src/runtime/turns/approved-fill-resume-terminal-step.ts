import { createHash } from "node:crypto"
import type { PoolClient } from "pg"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { canonicalJson } from "@jobcopilot/shared"
import type { CanonicalApprovedApplicationSubmitResumeProof } from "../canonical-approved-application-submit-resume-proof.js"
import { readRootTaskHistoryChronologyWitness } from "../context/root-task-history-chronology-witness.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import type { TurnLease } from "./lease.js"
import { getApprovedFillTerminalClaim } from "./approved-fill-terminal-claim.js"
import { matchesAgentOutboxIdentity, type AgentOutboxIdentity } from "../outbox-identity.js"
import { enforceRootStepAndUsageBudgets } from "./turn-engine-root-budget.js"
import type { AtomicTurnCompletionInput, TurnEngineEvent, TurnEngineEventInput } from "./turn-engine-types.js"

type Client = Pick<PoolClient, "query">; type Row = Record<string, unknown>
const descriptorBrand: unique symbol = Symbol("ApprovedFillResumeTerminalStep")
type Descriptor = Readonly<{ readonly [descriptorBrand]: true }>
type DescriptorData = Readonly<{
  proof: CanonicalApprovedApplicationSubmitResumeProof; lease: TurnLease; rootTaskId: string
  ordinal: number; inputThroughSequence: bigint; consumedInputIds: readonly string[]; modelProfileSnapshot: RepositoryJsonValue
  stepCount: number; toolCallCount: number
}>
const descriptors = new WeakMap<object, DescriptorData>()

export type ApprovedFillResumeTerminalStepDescriptor = Descriptor

/** Issues an in-process capability; callers must first prove this exact lease was claimed for the early Wait path. */
export function createApprovedFillResumeTerminalStepDescriptor(input: DescriptorData): ApprovedFillResumeTerminalStepDescriptor {
  const { proof, lease, rootTaskId } = input
  if (getApprovedFillTerminalClaim(lease) !== proof || proof.state !== "form_filled" || proof.workerTaskId !== null || proof.outboxId !== null
    || proof.userId !== lease.userId || proof.sessionId !== lease.sessionId || proof.turnId !== lease.turnId
    || proof.turnOwnerId !== lease.ownerId || proof.turnLeaseVersion !== lease.leaseVersion || proof.rootTaskId !== rootTaskId
    || !validId(rootTaskId) || !Number.isSafeInteger(input.ordinal) || input.ordinal < 0
    || input.inputThroughSequence < 0n || !uniqueIds(input.consumedInputIds)
    || !Number.isSafeInteger(input.stepCount) || input.stepCount < 1
    || !Number.isSafeInteger(input.toolCallCount) || input.toolCallCount < 0) throw new Error("approved_fill_terminal_descriptor_invalid")
  const modelProfileSnapshot = cloneJson(input.modelProfileSnapshot)
  if (!modelProfileSnapshot) throw new Error("approved_fill_terminal_descriptor_invalid")
  const token = Object.freeze({ [descriptorBrand]: true as const })
  descriptors.set(token, Object.freeze({ ...input, consumedInputIds: Object.freeze([...input.consumedInputIds]), modelProfileSnapshot }))
  return token
}

export function approvedFillResumeTerminalStepData(value: unknown): DescriptorData | undefined {
  if (!value || typeof value !== "object") return undefined
  return descriptors.get(value as object)
}

/** Persists or verifies the synthetic step wholly inside commitTurnTerminal's guarded transaction. */
export async function writeApprovedFillResumeTerminalStep(input: {
  client: Client; owner: TurnExecutionOwnerFence; terminal: AtomicTurnCompletionInput
  descriptor: ApprovedFillResumeTerminalStepDescriptor; now: Date; alreadyCommitted: boolean
  appendEvent: (event: TurnEngineEventInput) => Promise<TurnEngineEvent>
}): Promise<string> {
  const data = approvedFillResumeTerminalStepData(input.descriptor)
  if (!data || !matchesOwner(data, input.owner, input.terminal) || !validDate(input.now)) throw conflict()
  const start = await readTurnStarted(input.client, input.owner)
  const witness = await readRootTaskHistoryChronologyWitness(input.client, { userId: input.owner.userId, sessionId: input.owner.sessionId,
    turnId: input.owner.turnId, rootTaskId: input.owner.rootTaskId, boundary: "turn_start", boundaryEventId: start.id })
  if (!witness) throw conflict()
  const stepId = input.terminal.stepId
  const startedKey = `turn:${input.owner.turnId}:event:step-started:${stepId}`
  const completedKey = `turn:${input.owner.turnId}:event:step-completed:${stepId}`
  if (input.alreadyCommitted) return verifyCommittedStep(input.client, input.owner, input.terminal, data, start.id, startedKey, completedKey)

  await enforceRootStepAndUsageBudgets(input.client, input.owner)
  const next = await input.client.query<Row>(`SELECT COALESCE(MAX("ordinal"), -1) + 1 AS "ordinal" FROM "agent_steps"
    WHERE "sessionId"=$1 AND "turnId"=$2`, [input.owner.sessionId, input.owner.turnId])
  if (Number(next.rows[0]?.ordinal) !== data.ordinal) throw conflict()
  const prior = await input.client.query<Row>(`SELECT "id" FROM "agent_steps" WHERE "id"=$1 AND "sessionId"=$2 AND "turnId"=$3 LIMIT 2`,
    [stepId, input.owner.sessionId, input.owner.turnId])
  const priorEvents = await input.client.query<Row>(`SELECT "id" FROM "agent_events" WHERE "sessionId"=$1 AND "turnId"=$2 AND "idempotencyKey" IN ($3,$4) LIMIT 3`,
    [input.owner.sessionId, input.owner.turnId, startedKey, completedKey])
  if (prior.rows.length || priorEvents.rows.length) throw conflict()
  await input.client.query(`INSERT INTO "agent_steps"
    ("id","sessionId","turnId","taskId","ordinal","attempt","status","inputThroughSequence","consumedInputIds","modelProfileSnapshot","startedAt")
    VALUES ($1,$2,$3,$4,$5,1,'streaming',$6,$7::jsonb,$8::jsonb,$9)`,
  [stepId, input.owner.sessionId, input.owner.turnId, input.owner.taskId, data.ordinal, data.inputThroughSequence.toString(),
    JSON.stringify(data.consumedInputIds), JSON.stringify(data.modelProfileSnapshot), input.now])
  const started = await input.appendEvent({ owner: input.owner, id: eventId(input.owner.turnId, `step-started:${stepId}`), itemId: null,
    type: "step.started", correlationId: stepId, causationId: start.id, idempotencyKey: startedKey,
    payload: { stepId, ordinal: data.ordinal, taskId: input.owner.taskId } })
  const updated = await input.client.query(`UPDATE "agent_steps" SET "status"='completed',"finishReason"='stop',"errorCode"=NULL,
    "inputTokens"=0,"outputTokens"=0,"estimatedCostUsd"=0,"completedAt"=$1
    WHERE "id"=$2 AND "sessionId"=$3 AND "turnId"=$4 AND "taskId"=$5 AND "ordinal"=$6 AND "attempt"=1 AND "status"='streaming'`,
  [input.now, stepId, input.owner.sessionId, input.owner.turnId, input.owner.taskId, data.ordinal])
  if (updated.rowCount !== 1) throw conflict()
  const completed = await input.appendEvent({ owner: input.owner, id: eventId(input.owner.turnId, `step-completed:${stepId}`), itemId: null,
    type: "step.completed", correlationId: stepId, causationId: started.id, idempotencyKey: completedKey,
    payload: { stepId, status: "completed", taskId: input.owner.taskId } })
  return completed.id
}

function matchesOwner(data: DescriptorData, owner: TurnExecutionOwnerFence, terminal: AtomicTurnCompletionInput): boolean {
  return owner.kind === "turn" && owner.taskId === owner.rootTaskId && owner.userId === data.proof.userId
    && owner.sessionId === data.proof.sessionId && owner.turnId === data.proof.turnId && owner.rootTaskId === data.rootTaskId
    && owner.ownerId === data.lease.ownerId && owner.leaseVersion === data.lease.leaseVersion
    && terminal.stepId === `approved-fill-resume:${hash(data.proof.turnId)}:${data.lease.leaseVersion}:${data.ordinal}`
    && terminal.stepCount === data.stepCount && terminal.toolCallCount === data.toolCallCount
}
async function readTurnStarted(client: Client, owner: TurnExecutionOwnerFence): Promise<{ id: string }> {
  if (owner.kind !== "turn" || owner.taskId !== owner.rootTaskId) throw conflict()
  const result = await client.query<Row>(`SELECT "id","sessionId","turnId","taskId","itemId","type","actor","correlationId","causationId","idempotencyKey","payload"
    FROM "agent_events" WHERE "sessionId"=$1 AND "turnId"=$2 AND "taskId"=$3 AND "idempotencyKey"=$4 LIMIT 2 FOR SHARE`,
  [owner.sessionId, owner.turnId, owner.rootTaskId, `turn:${owner.turnId}:event:turn-started`])
  const row = result.rows[0], payload = plainRecord(row?.payload)
  if (result.rows.length !== 1 || typeof row?.id !== "string" || !row.id.trim() || row.sessionId !== owner.sessionId
    || row.turnId !== owner.turnId || row.taskId !== owner.rootTaskId || row.itemId !== null || row.type !== "turn.started"
    || row.actor !== "orchestrator" || row.correlationId !== owner.turnId || row.causationId !== null
    || row.idempotencyKey !== `turn:${owner.turnId}:event:turn-started` || payload?.taskId !== owner.rootTaskId
    || payload.rootTaskId !== owner.rootTaskId) throw conflict()
  return { id: row.id }
}
async function verifyCommittedStep(client: Client, owner: TurnExecutionOwnerFence, terminal: AtomicTurnCompletionInput, data: DescriptorData,
  startId: string, startedKey: string, completedKey: string): Promise<string> {
  const step = await client.query<Row>(`SELECT "id","sessionId","turnId","taskId","ordinal","attempt","status","inputThroughSequence","consumedInputIds","modelProfileSnapshot","finishReason","errorCode","inputTokens","outputTokens","estimatedCostUsd"
    FROM "agent_steps" WHERE "id"=$1 AND "sessionId"=$2 AND "turnId"=$3 LIMIT 2 FOR SHARE`, [terminal.stepId, owner.sessionId, owner.turnId])
  const events = await client.query<Row>(`SELECT "id","sessionId","turnId","taskId","itemId","sequence","type","actor","correlationId","causationId","idempotencyKey","payload"
    FROM "agent_events" WHERE "sessionId"=$1 AND "turnId"=$2 AND "idempotencyKey" IN ($3,$4) ORDER BY "sequence" ASC LIMIT 3 FOR SHARE`,
  [owner.sessionId, owner.turnId, startedKey, completedKey])
  const row = step.rows[0], first = events.rows[0], last = events.rows[1]
  if (step.rows.length !== 1 || events.rows.length !== 2 || !row || !first || !last || row.id !== terminal.stepId
    || row.taskId !== owner.taskId || Number(row.ordinal) !== data.ordinal || Number(row.attempt) !== 1 || row.status !== "completed"
    || String(row.inputThroughSequence) !== data.inputThroughSequence.toString() || !sameJson(row.consumedInputIds, data.consumedInputIds)
    || !sameJson(row.modelProfileSnapshot, data.modelProfileSnapshot) || row.finishReason !== "stop" || row.errorCode !== null
    || Number(row.inputTokens) !== 0 || Number(row.outputTokens) !== 0 || Number(row.estimatedCostUsd) !== 0
    || !eventMatches(first, owner, terminal.stepId, startedKey, "step.started", startId, { stepId: terminal.stepId, ordinal: data.ordinal, taskId: owner.taskId })
    || !eventMatches(last, owner, terminal.stepId, completedKey, "step.completed", String(first.id), { stepId: terminal.stepId, status: "completed", taskId: owner.taskId })
    || BigInt(String(first.sequence)) >= BigInt(String(last.sequence))) throw conflict()
  await verifyEventOutbox(client, first); await verifyEventOutbox(client, last)
  return String(last.id)
}
function eventMatches(row: Row, owner: TurnExecutionOwnerFence, stepId: string, key: string, type: string, causationId: string, payload: Row): boolean {
  return row.taskId === owner.taskId && row.turnId === owner.turnId && row.itemId === null && row.type === type
    && row.actor === "orchestrator" && row.correlationId === stepId && row.causationId === causationId
    && row.idempotencyKey === key && sameJson(row.payload, payload)
}
async function verifyEventOutbox(client: Client, event: Row): Promise<void> {
  const payload = plainRecord(event.payload)
  if (!payload || typeof event.id !== "string" || typeof event.sessionId !== "string" || typeof event.turnId !== "string"
    || typeof event.taskId !== "string" || typeof event.sequence !== "string" && typeof event.sequence !== "number" && typeof event.sequence !== "bigint"
    || typeof event.type !== "string" || typeof event.actor !== "string" || typeof event.correlationId !== "string"
    || typeof event.idempotencyKey !== "string") throw conflict()
  const expected: AgentOutboxIdentity = { id: `agent-outbox-${event.id}`, topic: "agent.events", aggregateId: event.sessionId,
    idempotencyKey: `agent-event:${event.id}`, payload: { eventId: event.id, sessionId: event.sessionId, turnId: event.turnId,
      taskId: event.taskId, itemId: null, sequence: String(event.sequence), type: event.type, actor: event.actor,
      correlationId: event.correlationId, causationId: typeof event.causationId === "string" ? event.causationId : null,
      idempotencyKey: event.idempotencyKey, payload: payload as RepositoryJsonValue } }
  const rows = await client.query<Row>(`SELECT "id","topic","aggregateId","idempotencyKey","payload" FROM "agent_outbox"
    WHERE "idempotencyKey"=$1 OR "id"=$2 FOR SHARE`, [expected.idempotencyKey, expected.id])
  if (rows.rows.length !== 1 || !matchesAgentOutboxIdentity(rows.rows[0], expected)) throw conflict()
}
function eventId(turnId: string, suffix: string): string { return `turn:${turnId}:event:${suffix}` }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex") }
function sameJson(left: unknown, right: unknown): boolean { try { return canonicalJson(left) === canonicalJson(right) } catch { return false } }
function uniqueIds(value: unknown): value is string[] { return Array.isArray(value) && value.every(validId) && new Set(value).size === value.length }
function validId(value: unknown): value is string { return typeof value === "string" && !!value.trim() && value.trim() === value && value.length <= 256 }
function validDate(value: unknown): value is Date { return value instanceof Date && Number.isFinite(value.getTime()) }
function plainRecord(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { return Object.getPrototypeOf(parsed) === Object.prototype ? parsed as Row : null } catch { return null }
}
function cloneJson(value: RepositoryJsonValue): RepositoryJsonValue | undefined {
  try { const parsed: unknown = JSON.parse(JSON.stringify(value)); return parsed as RepositoryJsonValue } catch { return undefined }
}
function conflict(): Error { return Object.assign(new Error("approved_application_fill_terminal_step_conflict"), { name: "TurnEnginePersistenceConflict" }) }
