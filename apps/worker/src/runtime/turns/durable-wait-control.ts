import type { DurableWaitControl, DurableWaitControlInvocation, DurableWaitControlReader } from "../tools/coordination-types.js"
import { isDurableWaitId } from "../tools/redaction.js"
import type { TurnExecutionIdentity } from "./turn-execution-types.js"
import { parseWaitRequest } from "./turn-execution-wait.js"
import { TurnEngineError } from "./turn-engine-types.js"

const TOOL_RESULT_LIMIT = 1_048_576
const WAIT_TOOLS = new Set(["agent.wait", "wait_subagents"])
type Row = Record<string, unknown>
export type ArchivedToolResultReference = { readonly $ref: string; readonly sizeBytes: number; readonly sha256: string }
function record(value: unknown): Row | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null }
function strictRecord(value: unknown, keys: readonly string[]): Row | null {
  const row = record(value)
  if (!row || (Object.getPrototypeOf(row) !== Object.prototype && Object.getPrototypeOf(row) !== null)) return null
  const own = Reflect.ownKeys(row)
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) return null
  return keys.every(key => { const item = Object.getOwnPropertyDescriptor(row, key); return !!item?.enumerable && "value" in item }) ? row : null
}

/** Recognize only the existing closed large-result envelope; inline outputs are not controls. */
export function parseArchivedWaitReference(value: unknown): ArchivedToolResultReference | null {
  const row = strictRecord(value, ["$ref", "sizeBytes", "sha256"]), candidate = record(value)
  if (!row) {
    if (candidate && Object.hasOwn(candidate, "$ref")) throw new TurnEngineError("invalid_output", "Archived wait result reference is invalid")
    return null
  }
  if (typeof row.$ref !== "string" || !/^tool-result-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.$ref)
    || typeof row.sizeBytes !== "number" || !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes < 1 || row.sizeBytes > TOOL_RESULT_LIMIT
    || typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256)) throw new TurnEngineError("invalid_output", "Archived wait result reference is invalid")
  return { $ref: row.$ref, sizeBytes: row.sizeBytes, sha256: row.sha256 }
}

/** Bind a model wait call to its existing server-owned durable invocation. */
export function archivedWaitInvocation(input: {
  readonly toolName: string; readonly input: unknown; readonly stepId: string
  readonly identity: TurnExecutionIdentity; readonly now: Date
}): DurableWaitControlInvocation | null {
  if (!WAIT_TOOLS.has(input.toolName) || input.identity.kind !== "turn" || input.identity.taskId !== input.identity.rootTaskId) return null
  const request = parseWaitRequest(input.input)
  if (!request) return null
  return {
    userId: input.identity.userId, sessionId: input.identity.sessionId, turnId: input.identity.turnId, stepId: input.stepId,
    taskId: input.identity.taskId, rootTaskId: input.identity.rootTaskId, ownerId: input.identity.ownerId,
    leaseVersion: input.identity.leaseVersion, now: input.now,
    targetTaskIds: request.taskIds, mode: request.mode, timeoutMs: request.timeoutMs, idempotencyKey: request.idempotencyKey,
  }
}

/** No archived envelope, task row, or result payload is returned to the Turn layer. */
export async function lookupArchivedWaitControl(input: {
  readonly toolName: string; readonly input: unknown; readonly stepId: string; readonly output: unknown
  readonly identity: TurnExecutionIdentity; readonly now: Date; readonly reader?: DurableWaitControlReader
  readonly allowInterruptedRecovery?: boolean
}): Promise<DurableWaitControl | null> {
  if (!WAIT_TOOLS.has(input.toolName)) return null
  if (!parseArchivedWaitReference(input.output)) return null
  const invocation = archivedWaitInvocation(input)
  if (!invocation || !input.reader) throw new TurnEngineError("persistence_conflict", "Archived wait control is unavailable")
  const row = strictRecord(await input.reader.readByInvocation(invocation), ["waitId", "status"])
  const validStatus = ["waiting", "ready", "timed_out"].includes(String(row?.status))
    || input.allowInterruptedRecovery === true && row?.status === "interrupted"
  if (!row || !isDurableWaitId(row.waitId) || !validStatus) {
    throw new TurnEngineError("persistence_conflict", "Archived wait control is unavailable")
  }
  return { waitId: row.waitId as string, status: row.status as DurableWaitControl["status"] }
}
