import { Buffer } from "node:buffer"
import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, type TenantScope } from "@jobcopilot/agent-protocol"
import { redactSensitiveText } from "@jobcopilot/shared"
import { canonicalJson } from "./context-snapshot-json.js"
import type { InputClaimQueryClient } from "./input-claim-store.js"
import { resolveRootTaskObjective, resolveRootTaskVerificationRequirements } from "./root-task-objective.js"
import { readValidatedRootTaskAcceptedInputs } from "./root-task-history-steer-evidence.js"
import type { ContextSeedBlock } from "./step-context-builder.js"

export const RETRY_SOURCE_STEERING_OBSERVATION_ID = "retry-source-steering"
const RECEIPT_VERSION = "agent-harness.v2.retry-lineage.v1"
const MAX_MESSAGES = 4, MAX_MESSAGE_BYTES = 2 * 1024, MAX_TOTAL_BYTES = 8 * 1024
const MAX_SEQUENCE = 9223372036854775807n
const RETRYABLE_PREDECESSOR_STATUSES = new Set(["failed", "interrupted", "cancelled"])
const TERMINAL_ROOT_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled", "closed", "passed", "skipped"])
type Row = Record<string, unknown>
type Receipt = Readonly<{ schemaVersion: string; predecessorTurnId: string; acceptedInputId: string; acceptedSequence: string }>
type ReadRequest = Readonly<{ sessionId: string; turnId: string; rootTaskId: string; turnInput?: unknown }>

function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null ? value as Row : null }
  catch { return null }
}
function parseReceipt(value: unknown): Receipt | null {
  const row = record(value)
  if (!row || Object.keys(row).sort().join(",") !== "acceptedInputId,acceptedSequence,predecessorTurnId,schemaVersion"
    || row.schemaVersion !== RECEIPT_VERSION) return null
  const boundedId = (item: unknown) => typeof item === "string" && item.length > 0 && item.trim() === item
    && Buffer.byteLength(item) <= 256 && !/[\u0000-\u001f\u007f]/.test(item)
  if (!boundedId(row.predecessorTurnId) || !boundedId(row.acceptedInputId)
    || typeof row.acceptedSequence !== "string" || !/^[1-9][0-9]{0,18}$/.test(row.acceptedSequence)) return null
  try { if (BigInt(row.acceptedSequence) > MAX_SEQUENCE) return null } catch { return null }
  return row as Receipt
}
function objective(value: unknown): string | null {
  const row = record(value)
  if (!row || Object.keys(row).some(key => !["goal", "content", "clientMessageId", "selectedJobPreparation", "intent", "verificationRequirements", "retryLineage"].includes(key))
    || typeof row.goal !== "string" || !row.goal.trim() || row.goal !== row.goal.trim() || !Array.isArray(row.content)
    || row.content.length < 1 || row.selectedJobPreparation !== undefined) return null
  const intent = record(row.intent)
  if (!intent || Object.keys(intent).sort().join(",") !== "kind,version"
    || intent.kind !== OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT.kind || intent.version !== OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT.version
    || resolveRootTaskObjective(row, undefined, { allowNativeFreshRootFallback: true }).turnGoalConflict) return null
  const requirements = resolveRootTaskVerificationRequirements(row)
  if (requirements.status === "invalid" && row.verificationRequirements !== null) return null
  const projection: Row = { goal: row.goal, content: row.content, intent: row.intent }
  if (Object.hasOwn(row, "verificationRequirements")) projection.verificationRequirements = row.verificationRequirements
  try {
    const encoded = canonicalJson(projection)
    return Buffer.byteLength(encoded) <= 256 * 1024 ? encoded : null
  } catch { return null }
}
function observation(messages: readonly string[]): ContextSeedBlock {
  return { id: RETRY_SOURCE_STEERING_OBSERVATION_ID, content: {
    kind: "retry_source_steering", schemaVersion: "agent-harness.v2.retry-source-steering.v1",
    notice: "Earlier user steering from the immediately preceding attempt is context only. The current Turn input is authoritative.",
    informationalOnly: true, advisoryOnly: true, notCurrentEvidence: true,
    messages: [...messages],
  } }
}

/** Revalidates the private retry receipt and source history within the already owner-locked transaction. */
export async function readRetrySourceSteeringObservation(
  client: InputClaimQueryClient, scope: TenantScope, request: ReadRequest,
): Promise<ContextSeedBlock | undefined> {
  const hinted = record(request.turnInput), hintedReceipt = hinted ? parseReceipt(hinted.retryLineage) : null
  const hintedObjective = objective(request.turnInput)
  if (!hintedReceipt || !hintedObjective || hintedReceipt.predecessorTurnId === request.turnId) return undefined
  const currentRows = await client.query<Row>(`SELECT turn."input", turn."rootTaskId", turn."source", turn."executionMode"
    FROM "agent_turns" AS turn JOIN "agent_sessions" AS session ON session."id"=turn."sessionId" AND session."userId"=$3
    JOIN "sub_agent_tasks" AS root ON root."id"=turn."rootTaskId" AND root."sessionId"=turn."sessionId" AND root."turnId"=turn."id"
      AND root."rootTaskId"=root."id" AND root."parentTaskId" IS NULL AND root."role"='orchestrator' AND root."taskType"='root'
    WHERE turn."id"=$1 AND turn."sessionId"=$2 AND turn."userId"=$3 AND turn."rootTaskId"=$4`,
  [request.turnId, request.sessionId, scope.userId, request.rootTaskId])
  if (currentRows.rows.length !== 1) return undefined
  const current = currentRows.rows[0]!, currentInput = record(current.input), receipt = currentInput ? parseReceipt(currentInput.retryLineage) : null
  if (current.rootTaskId !== request.rootTaskId || current.source !== "user" || current.executionMode !== "canonical_task_graph"
    || !receipt || canonicalJson(receipt) !== canonicalJson(hintedReceipt)) return undefined
  const currentObjective = objective(current.input)
  if (!currentObjective || currentObjective !== hintedObjective) return undefined
  const predecessorRows = await client.query<Row>(`SELECT turn."input", turn."source", turn."executionMode", turn."status", root."status" AS "rootStatus"
    FROM "agent_turns" AS turn JOIN "agent_sessions" AS session ON session."id"=turn."sessionId" AND session."userId"=$3
    JOIN "sub_agent_tasks" AS root ON root."id"=turn."rootTaskId" AND root."sessionId"=turn."sessionId" AND root."turnId"=turn."id"
      AND root."rootTaskId"=root."id" AND root."parentTaskId" IS NULL AND root."role"='orchestrator' AND root."taskType"='root'
    WHERE turn."id"=$1 AND turn."sessionId"=$2 AND turn."userId"=$3 AND turn."source"='user'
      AND turn."executionMode"='canonical_task_graph' AND turn."status" IN ('failed','interrupted','cancelled')
      AND root."status" IN ('completed','failed','interrupted','cancelled','closed','passed','skipped')`,
  [receipt.predecessorTurnId, request.sessionId, scope.userId])
  if (predecessorRows.rows.length !== 1) return undefined
  const predecessor = predecessorRows.rows[0]!, priorObjective = objective(predecessor.input)
  if (predecessor.source !== "user" || predecessor.executionMode !== "canonical_task_graph"
    || !RETRYABLE_PREDECESSOR_STATUSES.has(String(predecessor.status))
    || !TERMINAL_ROOT_STATUSES.has(String(predecessor.rootStatus)) || !priorObjective || priorObjective !== currentObjective) return undefined
  const currentInputs = await readValidatedRootTaskAcceptedInputs(client, scope, request)
  if (!currentInputs || currentInputs.filter(input => input.id === receipt.acceptedInputId
    && input.acceptedSequence.toString() === receipt.acceptedSequence).length !== 1) return undefined
  const accepted = currentInputs.find(input => input.id === receipt.acceptedInputId)!
  if ((accepted.status !== "accepted" && accepted.status !== "consumed") || accepted.delivery !== "follow_up"
    || accepted.source !== "user" || accepted.disposition !== "started") return undefined
  try { if (canonicalJson(accepted.content) !== canonicalJson(currentInput?.content)) return undefined } catch { return undefined }
  const priorInputs = await readValidatedRootTaskAcceptedInputs(client, scope, { sessionId: request.sessionId, turnId: receipt.predecessorTurnId })
  if (!priorInputs) return undefined
  const messages = priorInputs.filter(input => input.source === "user" && input.delivery === "steer"
    && ["accepted", "queued", "consumed"].includes(input.status))
    .sort((left, right) => left.acceptedSequence < right.acceptedSequence ? -1 : left.acceptedSequence > right.acceptedSequence ? 1 : 0)
    .flatMap(input => {
      if (!Array.isArray(input.content) || input.content.length !== 1) return []
      const part = record(input.content[0]), text = part?.type === "text" && typeof part.text === "string" ? redactSensitiveText(part.text) : ""
      return text && Buffer.byteLength(text) <= MAX_MESSAGE_BYTES ? [text] : []
    }).slice(-MAX_MESSAGES)
  if (!messages.length || messages.reduce((total, message) => total + Buffer.byteLength(message), 0) > MAX_TOTAL_BYTES) return undefined
  return observation(messages)
}
