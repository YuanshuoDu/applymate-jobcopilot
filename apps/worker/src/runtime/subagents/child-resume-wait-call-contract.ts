import { canonicalJson } from "@jobcopilot/shared"

import { parseModelCompletedReceipt } from "../turns/model-completed-receipt.js"
import type { ChildWaitCallRecovery } from "./child-durable-wait-replay.js"
import type { DurableWaitResume } from "./child-resume-observations.js"
import type { SubagentLease } from "./types.js"

export type ChildWaitRecoveryRow = Record<string, unknown>
export type ChildWaitModelUsage = ChildWaitCallRecovery["modelUsage"]
export type ChildWaitModelReceipt = Readonly<{ usage: ChildWaitModelUsage; sequence: bigint; eventId: string }>

export function childWaitRecoveryEventKey(lease: SubagentLease, key: string): string {
  return `task:${lease.id}:event:${key}`
}

export function childWaitRecoveryEventSequence(row: ChildWaitRecoveryRow): bigint | undefined {
  try {
    const value = BigInt(row.sequence as string | number | bigint)
    return value >= 0n ? value : undefined
  } catch { return undefined }
}

export function childWaitRecoveryExactKeys(value: ChildWaitRecoveryRow, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",")
}

export function childWaitRecoveryValidEvent(row: ChildWaitRecoveryRow, lease: SubagentLease, expected: ChildWaitRecoveryRow, payload: unknown): boolean {
  try {
    return canonicalJson(row.payload) === canonicalJson(payload) && row.sessionId === lease.sessionId && row.turnId === lease.turnId
      && row.taskId === lease.id && row.actor === "subagent" && row.type === expected.type && row.itemId === expected.itemId
      && row.correlationId === expected.correlationId && row.causationId === expected.causationId
      && row.idempotencyKey === expected.idempotencyKey
  } catch { return false }
}

export function childWaitRecoveryCausallyAfter(row: ChildWaitRecoveryRow, ancestorId: string, events: readonly ChildWaitRecoveryRow[]): boolean {
  let cause = row.causationId
  for (let depth = 0; depth < 32 && typeof cause === "string"; depth += 1) {
    if (cause === ancestorId) return true
    cause = events.find(event => event.id === cause)?.causationId
  }
  return false
}

export function childWaitRecoveryLogicalStepOrdinal(stepId: string, lease: SubagentLease): number | undefined {
  const prefix = `task:${lease.id}:step:`, suffix = `:attempt:${lease.attemptCount}`
  if (!stepId.startsWith(prefix) || !stepId.endsWith(suffix)) return undefined
  const raw = stepId.slice(prefix.length, -suffix.length)
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) return undefined
  const ordinal = Number(raw)
  return Number.isSafeInteger(ordinal) ? ordinal : undefined
}

export function childWaitResumeCursorIsValid(
  wait: { readonly attempt: number; readonly stepId: string; readonly ordinal: number; readonly continuationStepId?: string; readonly continuationOrdinal?: number },
  lease: SubagentLease, nextOrdinal: number, consumed: boolean,
): boolean {
  if (wait.attempt !== lease.attemptCount || !Number.isSafeInteger(wait.ordinal) || wait.ordinal < 0 || !Number.isSafeInteger(nextOrdinal)) return false
  const source = childWaitRecoveryLogicalStepOrdinal(wait.stepId, lease)
  const continuationPresent = wait.continuationStepId !== undefined || wait.continuationOrdinal !== undefined
  const continuation = wait.continuationStepId ? childWaitRecoveryLogicalStepOrdinal(wait.continuationStepId, lease) : undefined
  if (!continuationPresent) return !consumed && source !== undefined && nextOrdinal === source + 1
  return continuation !== undefined && Number.isSafeInteger(wait.continuationOrdinal) && wait.continuationOrdinal! > wait.ordinal
    && nextOrdinal >= continuation + (consumed ? 1 : 0)
}

export function childWaitLogicalResumeCursor(
  steps: readonly ChildWaitRecoveryRow[], lease: SubagentLease, wait: DurableWaitResume, recoveredStepOrdinal?: number,
): number {
  const ordered = steps.map(step => ({ ordinal: childWaitRecoveryLogicalStepOrdinal(String(step.id), lease), status: step.status, persisted: step.ordinal }))
  if (ordered.length === 0 || ordered.some(step => step.ordinal === undefined || !Number.isSafeInteger(step.persisted))) throw new Error("child_resume_wait_step_lineage")
  ordered.sort((left, right) => left.ordinal! - right.ordinal!)
  if (new Set(ordered.map(step => step.ordinal)).size !== ordered.length
    || ordered.some((step, index) => index > 0 && step.ordinal !== ordered[index - 1]!.ordinal! + 1)
    || ordered.some((step, index) => index > 0 && Number(step.persisted) <= Number(ordered[index - 1]!.persisted))) {
    throw new Error("child_resume_wait_step_lineage")
  }
  const sourceOrdinal = childWaitRecoveryLogicalStepOrdinal(wait.stepId, lease)
  const closed = new Set(["completed", "waiting_for_tool", "waiting_for_approval", "waiting_for_user"])
  const continuationOrdinal = wait.continuationStepId ? childWaitRecoveryLogicalStepOrdinal(wait.continuationStepId, lease) : undefined
  if (sourceOrdinal === undefined || !ordered.some(step => step.ordinal === sourceOrdinal)) {
    throw new Error("child_resume_wait_step_lineage")
  }
  if (wait.continuationStepId === undefined && wait.continuationOrdinal === undefined) {
    const latest = ordered.at(-1)!
    if (recoveredStepOrdinal !== undefined || latest.ordinal !== sourceOrdinal || !closed.has(String(latest.status))
      || ordered.slice(0, -1).some(step => !closed.has(String(step.status)))) throw new Error("child_resume_wait_step_lineage")
    return sourceOrdinal + 1
  }
  const continuation = ordered.find(step => step.ordinal === continuationOrdinal)
  if (continuationOrdinal !== sourceOrdinal + 1 || !continuation || continuation.persisted !== wait.continuationOrdinal) {
    throw new Error("child_resume_wait_step_lineage")
  }
  if (recoveredStepOrdinal !== undefined && recoveredStepOrdinal !== continuationOrdinal) throw new Error("child_resume_wait_step_lineage")
  if (ordered.slice(0, -1).some(step => !closed.has(String(step.status)))) throw new Error("child_resume_wait_step_lineage")
  const latest = ordered.at(-1)!
  if (latest.status === "queued") {
    if (latest.ordinal !== continuationOrdinal || recoveredStepOrdinal !== undefined) throw new Error("child_resume_wait_step_lineage")
    return latest.ordinal!
  }
  if (latest.status === "streaming") {
    if (latest.ordinal !== continuationOrdinal) throw new Error("child_resume_wait_step_lineage")
    return latest.ordinal! + (recoveredStepOrdinal === continuationOrdinal ? 1 : 0)
  }
  if (!["completed", "waiting_for_tool", "waiting_for_approval", "waiting_for_user"].includes(String(latest.status))) {
    throw new Error("child_resume_wait_step_lineage")
  }
  return latest.ordinal! + 1
}

export function parseChildWaitModelUsage(value: unknown): ChildWaitModelUsage | undefined {
  if (value === null) return { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const row = value as ChildWaitRecoveryRow
  if (!childWaitRecoveryExactKeys(row, ["inputTokens", "outputTokens", "estimatedCostUsd"])) return undefined
  const inputTokens = row.inputTokens, outputTokens = row.outputTokens, cost = row.estimatedCostUsd
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number" || typeof cost !== "number"
    || !Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0
    || !Number.isFinite(cost) || cost < 0) return undefined
  return { inputTokens, outputTokens, estimatedCostUsd: cost }
}

export function parseChildWaitModelUsageReceipt(
  events: readonly ChildWaitRecoveryRow[], lease: SubagentLease, stepId: string,
): ChildWaitModelReceipt {
  const keys = ["model-started", "model-completed", "model-usage"].map(key => childWaitRecoveryEventKey(lease, `${key}:${stepId}`))
  const rows = events.filter(event => String(event.type).startsWith("model.") || keys.includes(String(event.idempotencyKey)))
  const ofType = (type: string, key: string) => rows.filter(event => event.type === type || event.idempotencyKey === key)
  const [started] = ofType("model.started", keys[0]!), [completed] = ofType("model.completed", keys[1]!), [used] = ofType("model.usage", keys[2]!)
  if (rows.length !== 3 || ofType("model.started", keys[0]!).length !== 1 || ofType("model.completed", keys[1]!).length !== 1
    || ofType("model.usage", keys[2]!).length !== 1 || !started || !completed || !used) throw new Error("child_resume_wait_tool_call_conflict")
  const base = (row: ChildWaitRecoveryRow, type: string, key: string, payload: unknown) => childWaitRecoveryValidEvent(row, lease, {
    type, itemId: null, correlationId: stepId, causationId: row.causationId, idempotencyKey: key,
  }, payload)
  const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as ChildWaitRecoveryRow : null
  const startPayload = record(started.payload), completedPayload = record(completed.payload), usagePayload = record(used.payload)
  const completedReceipt = parseModelCompletedReceipt(completed.payload), modelUsage = parseChildWaitModelUsage(usagePayload?.usage)
  const sequence = [started, completed, used].map(childWaitRecoveryEventSequence)
  if (!startPayload || !childWaitRecoveryExactKeys(startPayload, ["taskId", "provider", "model"]) || startPayload.taskId !== lease.id
    || !completedReceipt || !childWaitRecoveryExactKeys(completedPayload ?? {}, ["taskId", "provider", "model", "toolCallCount"])
    || completedReceipt.taskId !== lease.id || completedReceipt.toolCallCount !== 1
    || !usagePayload || !childWaitRecoveryExactKeys(usagePayload, ["taskId", "provider", "model", "usage"]) || usagePayload.taskId !== lease.id
    || !modelUsage || !base(started, "model.started", keys[0]!, startPayload)
    || !base(completed, "model.completed", keys[1]!, completedPayload) || !base(used, "model.usage", keys[2]!, usagePayload)
    || completed.causationId !== started.id || used.causationId !== completed.id
    || completedReceipt.provider !== startPayload.provider || completedReceipt.model !== startPayload.model
    || usagePayload.provider !== completedReceipt.provider || usagePayload.model !== completedReceipt.model
    || sequence.some(value => value === undefined) || !(sequence[0]! < sequence[1]! && sequence[1]! < sequence[2]!)
    || typeof used.id !== "string" || !used.id.trim()) throw new Error("child_resume_wait_tool_call_conflict")
  return { usage: modelUsage, sequence: sequence[2]!, eventId: used.id as string }
}
