import type { DiscoveryAttemptLifecycleEvent, LifecycleCall } from "../tools/lifecycle.js"
import type { ToolExecutionContext } from "../tools/types.js"
import { captureDiscoveryQueryCriteria, createDiscoveryQueryFootprintForAttempts,
  type DiscoveryQueryCapture, type DiscoveryQueryFootprint } from "./child-discovery-query-footprint.js"

export const DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION = "agent-harness.v2.task-graph.discovery-attempt-health.v1" as const
const MAX_CALLS = 32
const MAX_COUNT = 1_000_000

export type DiscoveryAttemptHealth = Readonly<{
  schemaVersion: typeof DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION
  attemptedCalls: number
  completedCalls: number
  failedCalls: number
  unresolvedCalls: number
  candidateCount: number | null
  providerFailures: number | null
  materializationFailures: number | null
  hasMore: boolean | null
}>
export type DiscoveryAttemptSidecar = Readonly<{ attemptCount: number; health: DiscoveryAttemptHealth; queryFootprint?: DiscoveryQueryFootprint }>

export type DiscoveryAttemptCollectorFence = Readonly<{ taskId: string; rootTaskId: string; sessionId: string; turnId: string; attemptCount: number }>
type Receipt = Readonly<{
  requestCount: number | null
  candidateCount: number | null
  providerFailures: number | null
  materializationFailures: number | null
  hasMore: boolean | null
}>
type CallState = { readonly call: string; phase: "started" | "completed" | "failed" | "cancelled"; receipt?: Receipt; fingerprint?: string; query?: DiscoveryQueryCapture }

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null || Reflect.ownKeys(value).length !== keys.length) return null
    const record = value as Record<string, unknown>
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return null
    }
    return record
  } catch { return null }
}

function boundedCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_COUNT
}

function optionalCount(value: unknown): value is number | null {
  return value === null || boundedCount(value)
}

export function parseDiscoveryAttemptHealth(value: unknown): DiscoveryAttemptHealth | null {
  const fields = ["schemaVersion", "attemptedCalls", "completedCalls", "failedCalls", "unresolvedCalls", "candidateCount", "providerFailures", "materializationFailures", "hasMore"] as const
  const row = exactRecord(value, fields)
  if (!row || row.schemaVersion !== DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION
    || !boundedCount(row.attemptedCalls) || row.attemptedCalls < 1
    || !boundedCount(row.completedCalls) || !boundedCount(row.failedCalls) || !boundedCount(row.unresolvedCalls)
    || row.attemptedCalls !== row.completedCalls + row.failedCalls + row.unresolvedCalls
    || !optionalCount(row.candidateCount) || !optionalCount(row.providerFailures) || !optionalCount(row.materializationFailures)
    || row.hasMore !== null && typeof row.hasMore !== "boolean") return null
  if (row.unresolvedCalls > 0 && (row.candidateCount !== null || row.providerFailures !== null || row.materializationFailures !== null || row.hasMore !== null)) return null
  return {
    schemaVersion: DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION,
    attemptedCalls: row.attemptedCalls,
    completedCalls: row.completedCalls,
    failedCalls: row.failedCalls,
    unresolvedCalls: row.unresolvedCalls,
    candidateCount: row.candidateCount,
    providerFailures: row.providerFailures,
    materializationFailures: row.materializationFailures,
    hasMore: row.hasMore,
  }
}

export function parseDiscoveryAttemptSidecar(value: unknown, currentAttemptCount: number): DiscoveryAttemptHealth | null {
  const row = exactRecord(value, ["attemptCount", "health"])
    ?? exactRecord(value, ["attemptCount", "health", "queryFootprint"])
  if (!boundedCount(currentAttemptCount) || currentAttemptCount < 1 || !row
    || row.attemptCount !== currentAttemptCount) return null
  return parseDiscoveryAttemptHealth(row.health)
}

function safeUsage(value: unknown, call: LifecycleCall): Record<string, unknown> | null {
  const keys = ["ledgerKey", "toolName", "toolVersion", "toolCallId", "sessionId", "turnId", "stepId", "requests", "jobsProcessed", "jobsSucceeded", "jobsFailed", "providerFailures", "aiCalls", "providers", "estimatedCostUsd", "durationMs"]
  const optionalProviderFailures = exactRecord(value, keys) ?? exactRecord(value, keys.filter(key => key !== "providerFailures"))
  if (!optionalProviderFailures || optionalProviderFailures.toolName !== "jobs.discover" || optionalProviderFailures.toolVersion !== "1"
    || optionalProviderFailures.toolCallId !== call.id || optionalProviderFailures.sessionId !== call.sessionId
    || optionalProviderFailures.turnId !== call.turnId || optionalProviderFailures.stepId !== call.stepId
    || !boundedCount(optionalProviderFailures.requests) || !boundedCount(optionalProviderFailures.jobsProcessed)
    || !boundedCount(optionalProviderFailures.jobsSucceeded) || !boundedCount(optionalProviderFailures.jobsFailed)
    || !boundedCount(optionalProviderFailures.aiCalls) || !boundedCount(optionalProviderFailures.durationMs)
    || !Array.isArray(optionalProviderFailures.providers) || optionalProviderFailures.providers.length > 32
    || typeof optionalProviderFailures.estimatedCostUsd !== "number" || !Number.isFinite(optionalProviderFailures.estimatedCostUsd)
    || optionalProviderFailures.estimatedCostUsd < 0
    || Object.hasOwn(optionalProviderFailures, "providerFailures") && !boundedCount(optionalProviderFailures.providerFailures)) return null
  return optionalProviderFailures
}

function successfulReceipt(value: unknown, call: LifecycleCall): Receipt | null {
  const output = exactRecord(value, ["jobs", "evidence", "nextCursor", "usage"])
  if (!output || !Array.isArray(output.jobs) || output.jobs.length > 50
    || !Array.isArray(output.evidence) || output.evidence.length > 400
    || output.nextCursor !== null && (typeof output.nextCursor !== "string" || output.nextCursor.length < 1 || output.nextCursor.length > 512)) return null
  const usage = safeUsage(output.usage, call)
  if (!usage) return null
  return {
    requestCount: usage.requests as number,
    candidateCount: output.jobs.length,
    providerFailures: Object.hasOwn(usage, "providerFailures") ? usage.providerFailures as number : null,
    materializationFailures: usage.jobsFailed as number,
    hasMore: output.nextCursor !== null,
  }
}

function safeFailureUsage(value: unknown): Record<string, unknown> | null {
  const keys = ["requests", "jobsProcessed", "jobsSucceeded", "jobsFailed", "providers", "estimatedCostUsd", "durationMs"]
  const usage = exactRecord(value, [...keys, "providerFailures"])
    ?? exactRecord(value, keys)
  if (!usage || !boundedCount(usage.requests) || !boundedCount(usage.jobsProcessed)
    || !boundedCount(usage.jobsSucceeded) || !boundedCount(usage.jobsFailed)
    || !Array.isArray(usage.providers) || usage.providers.length > 32
    || usage.providers.some(provider => typeof provider !== "string" || provider.length < 1 || provider.length > 80)
    || typeof usage.estimatedCostUsd !== "number" || !Number.isFinite(usage.estimatedCostUsd) || usage.estimatedCostUsd < 0
    || !boundedCount(usage.durationMs)
    || Object.hasOwn(usage, "providerFailures") && !boundedCount(usage.providerFailures)) return null
  return usage
}

function failedReceipt(value: unknown): Receipt | null {
  const output = exactRecord(value, ["usage"])
  const usage = output && safeFailureUsage(output.usage)
  if (!usage) return null
  return {
    requestCount: usage.requests as number,
    candidateCount: null,
    providerFailures: Object.hasOwn(usage, "providerFailures") ? usage.providerFailures as number : null,
    materializationFailures: usage.jobsFailed as number,
    hasMore: null,
  }
}

function identity(call: LifecycleCall): string | null {
  if (call.toolName !== "jobs.discover" || call.toolVersion !== "1"
    || typeof call.id !== "string" || !call.id.trim() || call.id.length > 256
    || typeof call.stepId !== "string" || !call.stepId.trim() || call.stepId.length > 256) return null
  return `${call.stepId}\u0000${call.id}`
}

function matchesFence(call: LifecycleCall, fence: DiscoveryAttemptCollectorFence): boolean {
  return call.taskId === fence.taskId && call.rootTaskId === fence.rootTaskId
    && call.sessionId === fence.sessionId && call.turnId === fence.turnId
}

export function createChildDiscoveryAttemptCollector(fence: DiscoveryAttemptCollectorFence): {
  observeLifecycleEvent(event: DiscoveryAttemptLifecycleEvent): void
  observeEffectiveCriteria(context: ToolExecutionContext, capture: DiscoveryQueryCapture): void
  sidecar(): DiscoveryAttemptSidecar | undefined
} {
  const calls = new Map<string, CallState>()
  let failedClosed = !Number.isSafeInteger(fence.attemptCount) || fence.attemptCount < 1
  let queryFootprintInvalid = false

  const observeEffectiveCriteria = (context: ToolExecutionContext, capture: DiscoveryQueryCapture): void => {
    try {
      const call: LifecycleCall = {
        id: context.toolCallId ?? "", toolName: "jobs.discover", toolVersion: "1", sessionId: context.sessionId,
        turnId: context.turnId, stepId: context.stepId, taskId: context.taskId, rootTaskId: context.rootTaskId,
      }
      const key = identity(call), state = key ? calls.get(key) : undefined
      if (!key || !matchesFence(call, fence) || !state || state.phase !== "started" || state.query) {
        queryFootprintInvalid = true
        return
      }
      state.query = capture.availability === "captured"
        ? captureDiscoveryQueryCriteria(capture.criteria)
        : capture
      if (!state.query || state.query.availability !== "captured" && state.query.availability !== "omitted") queryFootprintInvalid = true
    } catch { queryFootprintInvalid = true }
  }

  const observeLifecycleEvent = (event: DiscoveryAttemptLifecycleEvent): void => {
    try {
      if (failedClosed || event.call.toolName !== "jobs.discover") return
      const key = identity(event.call)
      if (!key || !matchesFence(event.call, fence)) { failedClosed = true; return }
      let state = calls.get(key)
      if (!state) {
        if (event.phase !== "started") { failedClosed = true; return }
        if (calls.size >= MAX_CALLS) { failedClosed = true; return }
        state = { call: key, phase: "started" }
        calls.set(key, state)
      }
      if (event.phase === "started") {
        if (state.call !== key) failedClosed = true
        return
      }
      const receipt = event.phase === "completed"
        ? successfulReceipt(event.output, event.call)
        : failedReceipt(event.output)
      const fingerprint = receipt ? JSON.stringify([event.phase, receipt]) : undefined
      if (state.phase !== "started") {
        if (state.phase !== event.phase || state.fingerprint === undefined || state.fingerprint !== fingerprint) failedClosed = true
        return
      }
      state.phase = event.phase
      if (receipt) state.receipt = receipt
      state.fingerprint = fingerprint
    } catch { failedClosed = true }
  }

  const sidecar = (): DiscoveryAttemptSidecar | undefined => {
    if (failedClosed || calls.size === 0) return undefined
    const values = Array.from(calls.values())
    const completedCalls = values.filter(value => value.phase === "completed").length
    const failedCalls = values.filter(value => value.phase === "failed" || value.phase === "cancelled").length
    const unresolvedCalls = values.filter(value => value.phase === "started").length
    const invalidReceipt = values.some(value => value.phase !== "started" && !value.receipt)
    const receipts = values.flatMap(value => value.receipt ? [value.receipt] : [])
    const safeSum = (pick: (receipt: Receipt) => number | null): number | null => {
      if (unresolvedCalls > 0 || invalidReceipt || receipts.length !== values.length) return null
      let sum = 0
      for (const receipt of receipts) {
        const count = pick(receipt)
        if (count === null || sum > MAX_COUNT - count) return null
        sum += count
      }
      return sum
    }
    const hasObservedMore = receipts.some(receipt => receipt.hasMore === true)
    const hasMore = hasObservedMore ? true
      : unresolvedCalls > 0 || invalidReceipt || failedCalls > 0 ? null
      : receipts.every(receipt => receipt.hasMore === false) ? false : null
    const health = parseDiscoveryAttemptHealth({
      schemaVersion: DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION,
      attemptedCalls: values.length, completedCalls, failedCalls, unresolvedCalls,
      candidateCount: failedCalls > 0 ? null : safeSum(receipt => receipt.candidateCount),
      providerFailures: safeSum(receipt => receipt.providerFailures),
      materializationFailures: safeSum(receipt => receipt.materializationFailures),
      hasMore: unresolvedCalls > 0 || invalidReceipt ? null : hasMore,
    })
    if (!health) return undefined
    const sidecar: DiscoveryAttemptSidecar = { attemptCount: fence.attemptCount, health }
    return { ...sidecar, queryFootprint: createDiscoveryQueryFootprintForAttempts(values, queryFootprintInvalid) }
  }
  return { observeLifecycleEvent, observeEffectiveCriteria, sidecar }
}
