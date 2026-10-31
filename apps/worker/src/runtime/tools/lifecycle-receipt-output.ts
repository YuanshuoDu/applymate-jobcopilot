import type { ExecutionOwner } from "../execution-owner.js"
import type { DurableWaitOwnerKind } from "./durable-wait-output-redaction.js"
import { MAX_TOOL_RESULT_BYTES, MAX_TOOL_RESULT_READ_BYTES, type ToolResultChunk } from "./tool-result-reference-types.js"
import { ToolExecutionError } from "./types.js"
import {
  prepareDurableWaitOutput, prepareSafeValue, type PreparedLifecycleValue,
} from "./redaction.js"

const TOOL_RESULT_REF = /^tool-result-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function prepareOwnerScopedWaitLifecycleOutput(
  output: unknown,
  toolName: "agent.wait" | "wait_subagents",
  ownerKind: ExecutionOwner["kind"] | undefined,
): PreparedLifecycleValue {
  if (ownerKind !== "turn" && ownerKind !== "task") throw new Error("durable_wait_owner_missing")
  return prepareDurableWaitOutput(output, toolName, ownerKind as DurableWaitOwnerKind)
}

export function prepareResolvedOwnerWaitLifecycleOutput(
  output: unknown,
  toolName: "agent.wait" | "wait_subagents",
  resolveOwner: () => ExecutionOwner | undefined,
): PreparedLifecycleValue {
  try { return prepareOwnerScopedWaitLifecycleOutput(output, toolName, resolveOwner()?.kind) }
  catch { throw new ToolExecutionError("durable_wait_receipt_invalid", "Durable wait receipt is invalid") }
}

export function prepareVerifiedToolResultChunk(value: ToolResultChunk): PreparedLifecycleValue | null {
  const fields = ["ref", "sha256", "byteCount", "chunk", "nextCursor"] as const
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value) || Reflect.ownKeys(value).length !== fields.length) return null
    for (const field of fields) { const descriptor = Object.getOwnPropertyDescriptor(value, field); if (!descriptor?.enumerable || !("value" in descriptor)) return null }
    if (!TOOL_RESULT_REF.test(value.ref) || !/^[0-9a-f]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.byteCount)
      || value.byteCount < 0 || value.byteCount > MAX_TOOL_RESULT_BYTES || typeof value.chunk !== "string"
      || Buffer.byteLength(value.chunk, "utf8") > MAX_TOOL_RESULT_READ_BYTES || Buffer.from(value.chunk, "utf8").toString("utf8") !== value.chunk
      || value.nextCursor !== null && (!/^(0|[1-9]\d*)$/.test(value.nextCursor) || Number(value.nextCursor) > value.byteCount)
      || Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_TOOL_RESULT_READ_BYTES) return null
    return prepareSafeValue({ ref: value.ref, sha256: value.sha256, byteCount: value.byteCount, chunk: value.chunk, nextCursor: value.nextCursor })
  } catch { return null }
}

export function hasNativeCoordinationEnvelope(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "nativeCoordination")
}
