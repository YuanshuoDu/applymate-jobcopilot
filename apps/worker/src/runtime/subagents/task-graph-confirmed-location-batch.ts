import type pg from "pg"
import { canonicalJson } from "@jobcopilot/shared"
import { OBJECTIVE_LOCATION_STEER_ACCEPTED_EVENT_TYPE } from "@jobcopilot/agent-protocol"
import {
  readTaskGraphConfirmedLocationSteer,
  validateTaskGraphConfirmedLocationSteerCandidate,
  type TaskGraphConfirmedLocationSteerCandidate,
  type TaskGraphConfirmedLocationSteerScope,
} from "./task-graph-confirmed-location-steer.js"
import {
  parseSteeringReconciliationReceipt, steeringReconciliationId, steeringReconciliationIdempotencyKey,
  validSteeringReconciliationScope, STEERING_RECONCILIATION_MAX_UNRESOLVED_INPUTS,
  type PreparedSteeringReconciliation, type SteeringReconciliationState,
} from "./steering-reconciliation-contract.js"
import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type Member = SteeringReconciliationState["unresolvedInputs"][number]
type ExpectedMember = Readonly<{ id: string; acceptedSequence?: bigint; consumedByStepId?: string | null; consumingOrdinal?: number | null }>
export type TaskGraphConfirmedLocationBatchResult =
  | Readonly<{ kind: "absent" | "pending" | "unavailable" }>
  | Readonly<{ kind: "confirmed"; locations: readonly string[]; acceptedInputSequence: bigint; acceptedInputId: string;
    acceptedInputIds: readonly string[]; acceptedInputSequences: readonly bigint[] }>
export type TaskGraphConfirmedLocationBatchInput = Readonly<{
  client: Client
  scope: TaskGraphExecutionScope
  consumedThroughSequence: bigint
  prepared: PreparedSteeringReconciliation
  reconciliation: SteeringReconciliationState
}>
export type TaskGraphConfirmedLocationBatchReceiptInput = Readonly<{
  client: Client
  scope: TaskGraphConfirmedLocationSteerScope
  consumedThroughSequence: bigint
  inputIds: readonly string[]
  inputThroughSequence: bigint
  decisionStep: Readonly<{ id: string; ordinal: number; attempt: number }>
}>
const UNAVAILABLE: TaskGraphConfirmedLocationBatchResult = Object.freeze({ kind: "unavailable" })
const MAX_SEQUENCE = (1n << 63n) - 1n

/** Rebinds an exact prepared set of typed location inputs and selects its greatest accepted sequence. */
export async function readTaskGraphConfirmedLocationBatch(input: TaskGraphConfirmedLocationBatchInput): Promise<TaskGraphConfirmedLocationBatchResult> {
  try {
    const members = preparedMembers(input)
    if (!members) return UNAVAILABLE
    if (members.length === 1) {
      const member = members[0]!
      const candidate = await readTaskGraphConfirmedLocationSteer(input.client, identityScope(input.scope), input.consumedThroughSequence)
      if (candidate.kind !== "confirmed") return candidate.kind === "pending" ? candidate : UNAVAILABLE
      return candidate.acceptedInputId === member.id && candidate.acceptedInputSequence === member.acceptedSequence
        ? { ...candidate, acceptedInputIds: [member.id], acceptedInputSequences: [member.acceptedSequence] } : UNAVAILABLE
    }
    return finishBatch(await readTaskGraphConfirmedLocationBatchRows({
      client: input.client, scope: identityScope(input.scope), consumedThroughSequence: input.consumedThroughSequence,
      inputThroughSequence: input.prepared.inputThroughSequence,
      inputIds: members.map(member => member.id),
      decisionStep: { id: input.reconciliation.decisionStepId!, ordinal: input.reconciliation.decisionStepOrdinal!,
        attempt: input.reconciliation.decisionStepAttempt! },
      members,
    }), members.map(member => member.id))
  } catch { return UNAVAILABLE }
}

/** Rebinds the exact typed input membership from one already-validated reconciliation receipt. */
export async function readTaskGraphConfirmedLocationBatchForReceipt(
  input: TaskGraphConfirmedLocationBatchReceiptInput,
): Promise<TaskGraphConfirmedLocationBatchResult> {
  try {
    if (!input || !input.client || typeof input.client.query !== "function" || !input.decisionStep
      || !steeringReconciliationId(input.decisionStep.id) || !Number.isSafeInteger(input.decisionStep.ordinal)
      || input.decisionStep.ordinal < 0 || !Number.isSafeInteger(input.decisionStep.attempt) || input.decisionStep.attempt < 1
      || typeof input.inputThroughSequence !== "bigint" || input.inputThroughSequence <= 0n || input.inputThroughSequence > MAX_SEQUENCE
      || typeof input.consumedThroughSequence !== "bigint" || input.consumedThroughSequence < input.inputThroughSequence
      || input.consumedThroughSequence > MAX_SEQUENCE || !Array.isArray(input.inputIds) || input.inputIds.length < 1
      || input.inputIds.length > STEERING_RECONCILIATION_MAX_UNRESOLVED_INPUTS
      || new Set(input.inputIds).size !== input.inputIds.length || input.inputIds.some((id, index) =>
        !steeringReconciliationId(id) || index > 0 && input.inputIds[index - 1]! >= id)) return UNAVAILABLE
    const members = input.inputIds.map(id => ({ id }))
    return finishBatch(await readTaskGraphConfirmedLocationBatchRows({ ...input, members }), input.inputIds)
  } catch { return UNAVAILABLE }
}

function preparedMembers(input: TaskGraphConfirmedLocationBatchInput): readonly Member[] | null {
  if (!input || !input.client || typeof input.client.query !== "function" || !input.prepared || !input.reconciliation) return null
  const { prepared, reconciliation: state } = input
  if (!validSteeringReconciliationScope(prepared.scope) || prepared.decision !== "revise" || state.currentRevision !== prepared.expectedRevision
    || prepared.resultingRevision !== prepared.expectedRevision + 1 || !Number.isSafeInteger(prepared.expectedRevision)
    || state.agendaPlanRevision !== prepared.expectedRevision || state.decisionStepId !== prepared.scope.stepId
    || state.decisionStepAttempt !== prepared.scope.parentAttemptCount || !Number.isSafeInteger(state.decisionStepOrdinal)
    || state.decisionInputThroughSequence !== prepared.inputThroughSequence
    || input.consumedThroughSequence !== prepared.inputThroughSequence || prepared.inputThroughSequence <= 0n
    || prepared.inputThroughSequence > MAX_SEQUENCE || prepared.scope.userId !== input.scope.userId
    || prepared.scope.sessionId !== input.scope.sessionId || prepared.scope.turnId !== input.scope.turnId
    || prepared.scope.rootTaskId !== input.scope.rootTaskId || prepared.scope.parentTaskId !== input.scope.rootTaskId
    || canonicalJson(prepared.scope) !== canonicalJson(input.scope)
    || !steeringReconciliationIdempotencyKey(prepared.scope, prepared.callId)
    || prepared.idempotencyKey !== steeringReconciliationIdempotencyKey(prepared.scope, prepared.callId)) return null
  const receipt = parseSteeringReconciliationReceipt(prepared.receipt, { ...prepared.scope })
  if (!receipt || receipt.decision !== "revise" || receipt.stepId !== prepared.scope.stepId
    || receipt.observedRevision !== prepared.expectedRevision || receipt.resultingRevision !== prepared.resultingRevision
    || receipt.inputCheckpoint.throughSequence !== prepared.inputThroughSequence.toString()
    || canonicalJson(receipt.steerInputIds) !== canonicalJson(prepared.steerInputIds)
    || !Array.isArray(prepared.steerInputIds) || prepared.steerInputIds.length < 1
    || prepared.steerInputIds.length > STEERING_RECONCILIATION_MAX_UNRESOLVED_INPUTS
    || prepared.steerInputIds.some(id => !steeringReconciliationId(id))
    || new Set(prepared.steerInputIds).size !== prepared.steerInputIds.length
    || prepared.steerInputIds.some((id, index) => index > 0 && prepared.steerInputIds[index - 1]! >= id)) return null
  const members = state.unresolvedInputs.filter(item => item.acceptedSequence <= prepared.inputThroughSequence)
  if (members.length !== prepared.steerInputIds.length
    || new Set(members.map(member => member.acceptedSequence)).size !== members.length
    || canonicalJson(members.map(member => member.id).sort()) !== canonicalJson(prepared.steerInputIds)) return null
  for (const member of members) {
    const ordinal = member.consumingOrdinal
    if (member.status !== "consumed" || !steeringReconciliationId(member.id) || member.acceptedSequence <= 0n
      || member.acceptedSequence > prepared.inputThroughSequence || !steeringReconciliationId(member.consumedByStepId)
      || !Number.isSafeInteger(ordinal) || ordinal === null || ordinal < 0 || ordinal > state.decisionStepOrdinal!
      || member.consumedByStepId === state.decisionStepId && ordinal !== state.decisionStepOrdinal) return null
  }
  return members.sort((left, right) => left.acceptedSequence < right.acceptedSequence ? -1 : left.acceptedSequence > right.acceptedSequence ? 1 : 0)
}

function identityScope(scope: TaskGraphConfirmedLocationSteerScope): TaskGraphConfirmedLocationSteerScope {
  return { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId }
}

async function readTaskGraphConfirmedLocationBatchRows(input: TaskGraphConfirmedLocationBatchReceiptInput & Readonly<{ members: readonly ExpectedMember[] }>): Promise<readonly Row[] | null> {
  const result = await input.client.query<Row>(`SELECT location_event."id" AS "eventId", location_event."sessionId" AS "eventSessionId",
      location_event."turnId" AS "eventTurnId", location_event."taskId" AS "eventTaskId", location_event."sequence" AS "eventSequence",
      location_event."type" AS "eventType", location_event."actor" AS "eventActor", location_event."correlationId" AS "eventCorrelationId",
      location_event."causationId" AS "eventCausationId", location_event."itemId" AS "eventItemId", location_event."payload" AS "eventPayload",
      turn."rootTaskId" AS "turnRootTaskId", turn."userId" AS "turnUserId", session."userId" AS "sessionUserId",
      turn."source" AS "turnSource", turn."executionMode" AS "turnExecutionMode",
      input."id" AS "inputId", input."sessionId" AS "inputSessionId", input."targetTurnId" AS "inputTurnId", input."userId" AS "inputUserId",
      input."clientMessageId", input."delivery", input."status", input."content" AS "inputContent", input."acceptedSequence",
      input."consumedByStepId", input."consumedAt", input."cancelledAt", accepted_event."id" AS "acceptedEventId",
      accepted_event."sessionId" AS "acceptedSessionId", accepted_event."turnId" AS "acceptedTurnId",
      accepted_event."sequence" AS "acceptedEventSequence", accepted_event."type" AS "acceptedType", accepted_event."actor" AS "acceptedActor",
      accepted_event."taskId" AS "acceptedTaskId", accepted_event."correlationId" AS "acceptedCorrelationId",
      accepted_event."causationId" AS "acceptedCausationId", accepted_event."itemId" AS "acceptedItemId", accepted_event."payload" AS "acceptedPayload",
      accepted_item."id" AS "acceptedItemJoinedId", accepted_item."sessionId" AS "acceptedItemSessionId",
      accepted_item."turnId" AS "acceptedItemTurnId", accepted_item."type" AS "acceptedItemType", accepted_item."taskId" AS "acceptedItemTaskId",
      accepted_item."stepId" AS "acceptedItemStepId", accepted_item."status" AS "acceptedItemStatus", accepted_item."phase" AS "acceptedItemPhase",
      accepted_item."revision" AS "acceptedItemRevision", accepted_item."content" AS "acceptedItemContent",
      step."id" AS "stepId", step."sessionId" AS "stepSessionId", step."turnId" AS "stepTurnId", step."taskId" AS "stepTaskId",
      step."ordinal", step."attempt", step."status" AS "stepStatus", step."inputThroughSequence", step."consumedInputIds",
      (SELECT COUNT(*)::int FROM "agent_events" duplicate_event JOIN "agent_turns" duplicate_turn
        ON duplicate_turn."id" = duplicate_event."turnId" AND duplicate_turn."sessionId" = duplicate_event."sessionId"
        JOIN "agent_sessions" duplicate_session ON duplicate_session."id" = duplicate_event."sessionId"
          AND duplicate_session."userId" = duplicate_turn."userId"
        WHERE duplicate_event."sessionId" = location_event."sessionId" AND duplicate_event."turnId" = location_event."turnId"
          AND duplicate_event."type" = location_event."type" AND duplicate_event."causationId" = location_event."causationId"
          AND duplicate_event."id" <> location_event."id" AND duplicate_turn."rootTaskId" = $4
          AND duplicate_turn."userId" = $1 AND duplicate_session."userId" = $1) AS "duplicateCount"
    FROM "agent_inputs" input JOIN "agent_turns" turn ON turn."id" = input."targetTurnId" AND turn."sessionId" = input."sessionId"
      AND turn."userId" = input."userId"
    JOIN "agent_sessions" session ON session."id" = input."sessionId" AND session."userId" = input."userId"
    JOIN "agent_events" accepted_event ON accepted_event."sessionId" = input."sessionId" AND accepted_event."turnId" = input."targetTurnId"
      AND accepted_event."sequence" = input."acceptedSequence"
    JOIN "agent_events" location_event ON location_event."sessionId" = accepted_event."sessionId"
      AND location_event."turnId" = accepted_event."turnId" AND location_event."causationId" = accepted_event."id"
      AND location_event."type" = $7 AND location_event."payload"->>'acceptedInputSequence' = input."acceptedSequence"::text
    LEFT JOIN "agent_items" accepted_item ON accepted_item."id" = accepted_event."itemId"
      AND accepted_item."sessionId" = accepted_event."sessionId" AND accepted_item."turnId" = accepted_event."turnId"
    LEFT JOIN "agent_steps" step ON step."id" = input."consumedByStepId" AND step."sessionId" = input."sessionId"
      AND step."turnId" = input."targetTurnId" AND step."taskId" = $4
    WHERE input."sessionId" = $2 AND input."targetTurnId" = $3 AND input."userId" = $1 AND input."id" = ANY($5::text[])
      AND turn."rootTaskId" = $4 AND session."userId" = $1
    ORDER BY input."acceptedSequence" ASC LIMIT $6`,
  [input.scope.userId, input.scope.sessionId, input.scope.turnId, input.scope.rootTaskId, input.members.map(member => member.id), input.members.length + 1,
    OBJECTIVE_LOCATION_STEER_ACCEPTED_EVENT_TYPE])
  if (result.rows.length !== input.members.length) return null
  const byId = new Map(input.members.map(member => [member.id, member] as const)), rows: Row[] = []
  for (const row of result.rows) {
    const event = { id: row.eventId, sessionId: row.eventSessionId, turnId: row.eventTurnId, taskId: row.eventTaskId,
      sequence: row.eventSequence, type: row.eventType, actor: row.eventActor, correlationId: row.eventCorrelationId,
      causationId: row.eventCausationId, itemId: row.eventItemId, payload: row.eventPayload, turnRootTaskId: row.turnRootTaskId,
      turnUserId: row.turnUserId, sessionUserId: row.sessionUserId, turnSource: row.turnSource, turnExecutionMode: row.turnExecutionMode }
    const accepted = { ...row }
    const step = row.stepId === null ? [] : [{ stepId: row.stepId, sessionId: row.stepSessionId, turnId: row.stepTurnId,
      taskId: row.stepTaskId, ordinal: row.ordinal, attempt: row.attempt, status: row.stepStatus,
      inputThroughSequence: row.inputThroughSequence, consumedInputIds: row.consumedInputIds,
      turnRootTaskId: row.turnRootTaskId, turnUserId: row.turnUserId, sessionUserId: row.sessionUserId }]
    const candidate: TaskGraphConfirmedLocationSteerCandidate = { event, acceptedRows: [accepted],
      duplicateCount: Number(row.duplicateCount), stepRows: step }
    const checked = validateTaskGraphConfirmedLocationSteerCandidate(candidate, identityScope(input.scope), input.consumedThroughSequence)
    if (checked.kind !== "confirmed") return null
    const member = byId.get(checked.acceptedInputId), consumerStep = step[0]
    if (!member || member.acceptedSequence !== undefined && member.acceptedSequence !== checked.acceptedInputSequence
      || checked.acceptedInputSequence > input.inputThroughSequence || step.length !== 1
      || member.consumedByStepId !== undefined && consumerStep?.stepId !== member.consumedByStepId
      || member.consumingOrdinal !== undefined && consumerStep?.ordinal !== member.consumingOrdinal
      || Number(consumerStep?.ordinal) > input.decisionStep.ordinal
      || consumerStep?.stepId === input.decisionStep.id && (Number(consumerStep.ordinal) !== input.decisionStep.ordinal
        || Number(consumerStep.attempt) !== input.decisionStep.attempt)) return null
    rows.push({ ...row, __locations: checked.locations, __acceptedSequence: checked.acceptedInputSequence, __acceptedInputId: checked.acceptedInputId })
  }
  return rows
}

function finishBatch(rows: readonly Row[] | null, inputIds: readonly string[]): TaskGraphConfirmedLocationBatchResult {
  if (!rows || rows.length !== inputIds.length) return UNAVAILABLE
  const sorted = [...rows].sort((left, right) => {
    const a = left.__acceptedSequence as bigint, b = right.__acceptedSequence as bigint
    return a < b ? -1 : a > b ? 1 : 0
  })
  const last = sorted.at(-1)
  if (!last || !Array.isArray(last.__locations) || typeof last.__acceptedSequence !== "bigint"
    || typeof last.__acceptedInputId !== "string") return UNAVAILABLE
  const acceptedInputIds = sorted.map(row => row.__acceptedInputId as string)
  const acceptedInputSequences = sorted.map(row => row.__acceptedSequence as bigint)
  if (new Set(acceptedInputIds).size !== inputIds.length || canonicalJson(acceptedInputIds.slice().sort()) !== canonicalJson(inputIds.slice().sort())) return UNAVAILABLE
  return { kind: "confirmed", locations: last.__locations as readonly string[], acceptedInputSequence: last.__acceptedSequence,
    acceptedInputId: last.__acceptedInputId, acceptedInputIds, acceptedInputSequences }
}
