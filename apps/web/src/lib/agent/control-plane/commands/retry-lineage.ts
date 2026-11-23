import type { Prisma } from "@prisma/client"
import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT } from "@jobcopilot/agent-protocol"
import type { CommandIdentity } from "./types"
import type { AcceptedCommandFacts, CommandTransaction } from "./transaction"

export const RETRY_LINEAGE_SCHEMA_VERSION = "agent-harness.v2.retry-lineage.v1" as const

export type RetryLineageReceipt = Readonly<{
  schemaVersion: typeof RETRY_LINEAGE_SCHEMA_VERSION
  predecessorTurnId: string
  acceptedInputId: string
  acceptedSequence: string
}>

const MAX_SEQUENCE = BigInt("9223372036854775807")
const RECEIPT_KEYS = ["schemaVersion", "predecessorTurnId", "acceptedInputId", "acceptedSequence"] as const

function dataRecord(value: unknown, keys?: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    const ownKeys = Reflect.ownKeys(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if ((prototype !== Object.prototype && prototype !== null) || ownKeys.some(key => typeof key !== "string" ||
      (keys && !keys.includes(key)))) return null
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of ownKeys as string[]) {
      const descriptor = descriptors[key]
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null
      result[key] = descriptor.value
    }
    return result
  } catch { return null }
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value
    && new TextEncoder().encode(value).byteLength <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
}

export function parseRetryLineageReceipt(value: unknown): RetryLineageReceipt | null {
  const row = dataRecord(value, RECEIPT_KEYS)
  if (!row || Object.keys(row).length !== RECEIPT_KEYS.length || row.schemaVersion !== RETRY_LINEAGE_SCHEMA_VERSION
    || !identifier(row.predecessorTurnId) || !identifier(row.acceptedInputId)
    || typeof row.acceptedSequence !== "string" || !/^[1-9][0-9]{0,18}$/.test(row.acceptedSequence)) return null
  try {
    if (BigInt(row.acceptedSequence) > MAX_SEQUENCE) return null
  } catch { return null }
  return { schemaVersion: RETRY_LINEAGE_SCHEMA_VERSION, predecessorTurnId: row.predecessorTurnId,
    acceptedInputId: row.acceptedInputId, acceptedSequence: row.acceptedSequence }
}

export function isRetryLineageEligiblePredecessor(source: unknown, executionMode: unknown, input: Readonly<{
  intent?: unknown
  selectedJobPreparation?: unknown
}>): boolean {
  const intent = dataRecord(input.intent, ["kind", "version"])
  return source === "user" && executionMode === "canonical_task_graph" && input.selectedJobPreparation === undefined && intent !== null
    && Object.keys(intent).length === 2 && intent.kind === OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT.kind
    && intent.version === OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT.version
}

export function addRetryLineage(input: unknown, receipt: RetryLineageReceipt): Record<string, unknown> | null {
  const row = dataRecord(input)
  if (!row || Object.hasOwn(row, "retryLineage") || !parseRetryLineageReceipt(receipt)) return null
  return { ...row, retryLineage: receipt }
}

function json(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue }

export async function bindRetryLineageReceipt(tx: CommandTransaction, input: Readonly<{
  sessionId: string; userId: string; turnId: string; predecessorTurnId: string; acceptedInputId: string; acceptedSequence: string
}>): Promise<RetryLineageReceipt> {
  const receipt = parseRetryLineageReceipt({ schemaVersion: RETRY_LINEAGE_SCHEMA_VERSION,
    predecessorTurnId: input.predecessorTurnId, acceptedInputId: input.acceptedInputId, acceptedSequence: input.acceptedSequence })
  if (!receipt || receipt.predecessorTurnId === input.turnId) throw new Error("retry_lineage_receipt_invalid")
  const turn = await tx.agentTurn.findFirst({
    where: { id: input.turnId, sessionId: input.sessionId, userId: input.userId, source: "user" }, select: { input: true },
  })
  const persisted = turn && addRetryLineage(turn.input, receipt)
  if (!persisted) throw new Error("retry_lineage_turn_scope_invalid")
  const updated = await tx.agentTurn.updateMany({
    where: { id: input.turnId, sessionId: input.sessionId, userId: input.userId, source: "user" }, data: { input: json(persisted) },
  })
  if (updated.count !== 1) throw new Error("retry_lineage_turn_scope_invalid")
  return receipt
}

export async function acceptRetriedInput(tx: CommandTransaction, command: CommandIdentity,
  target: Readonly<{ id: string; source: string; executionMode: string | null }>,
  persisted: Readonly<{ intent?: unknown; selectedJobPreparation?: unknown }>, accept: () => Promise<AcceptedCommandFacts>): Promise<AcceptedCommandFacts & { disposition: "started" }> {
  const facts = await accept()
  if (command.source === "user" && isRetryLineageEligiblePredecessor(target.source, target.executionMode, persisted)) {
    await bindRetryLineageReceipt(tx, { sessionId: command.sessionId, userId: command.userId, turnId: facts.turnId,
      predecessorTurnId: target.id, acceptedInputId: facts.inputId, acceptedSequence: facts.sequence })
  }
  return { ...facts, disposition: "started" }
}
