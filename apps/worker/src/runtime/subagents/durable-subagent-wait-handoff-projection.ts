import { DurableSubagentWaitError, safeSubagentWaitJson, type DurableSubagentWaitResult } from "./durable-subagent-wait-store.js"
import { markCanonicalSubagentWaitTargetIds } from "./subagent-wait-structural-ids.js"

type WaitRequest = Readonly<{ mode: "any" | "all"; targetTaskIds: readonly string[]; timeoutMs: number }>

export function strictWaitTargetIds(value: unknown): string[] {
  let parsed: unknown = value
  if (typeof value === "string") {
    try { parsed = JSON.parse(value) as unknown } catch { parsed = undefined }
  }
  const ids: unknown[] | undefined = Array.isArray(parsed) ? parsed : undefined
  if (!ids || ids.length < 1 || ids.length > 8
    || !Array.from(ids).every(id => typeof id === "string" && id.length > 0 && id.length <= 256 && id.trim() === id)
    || new Set(ids).size !== ids.length) {
    throw new DurableSubagentWaitError("wait_scope_error", "Wait targets are invalid")
  }
  return ids as string[]
}

function sameIds(value: unknown, expected: readonly string[]): value is string[] {
  return Array.isArray(value) && value.length === expected.length && value.every(id => typeof id === "string")
    && [...value].sort().join("\u0000") === [...expected].sort().join("\u0000")
}

/** Preserve request IDs only after call and direct-child scope have been validated by the caller. */
export function safeHandoffWaitResult(
  result: Record<string, unknown>, outcome: DurableSubagentWaitResult, validatedTargetIds: readonly string[],
): unknown {
  const request = result.request && typeof result.request === "object" && !Array.isArray(result.request)
    ? result.request as Record<string, unknown> : {}
  if (Object.keys(request).sort().join(",") !== "mode,targetTaskIds,timeoutMs"
    || !(request.mode === "any" || request.mode === "all") || !Number.isSafeInteger(request.timeoutMs)
    || Number(request.timeoutMs) < 1 || Number(request.timeoutMs) > 24 * 60 * 60 * 1_000
    || !sameIds(request.targetTaskIds, validatedTargetIds)) {
    throw new DurableSubagentWaitError("wait_scope_error", "Persisted wait request changed scope")
  }
  const canonicalRequest: WaitRequest = {
    mode: request.mode, targetTaskIds: [...validatedTargetIds], timeoutMs: Number(request.timeoutMs),
  }
  if (!markCanonicalSubagentWaitTargetIds(canonicalRequest, outcome, validatedTargetIds)) {
    throw new DurableSubagentWaitError("wait_scope_error", "Persisted wait projection changed scope")
  }
  return safeSubagentWaitJson({ ...result, request: canonicalRequest, outcome }, 16_384)
}
