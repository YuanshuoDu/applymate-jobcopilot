import { createHash } from "node:crypto"
import { Buffer } from "node:buffer"
import { types as nodeTypes } from "node:util"
import type { DiscoveryAttemptLifecycleEvent, LifecycleCall } from "../tools/lifecycle.js"
import { isCanonicalTaskGraphJobId } from "./task-graph-result-page-contract.js"
import {
  DISCOVERY_RECOVERY_SCHEMA_VERSION, MAX_DISCOVERY_RECOVERY_JOB_IDS, parseDiscoveryRecovery,
  type DiscoveryRecoverySnapshot,
} from "./task-graph-discovery-recovery-contract.js"

export type DiscoveryRecoveryCollectorFence = Readonly<{
  taskId: string; rootTaskId: string; sessionId: string; turnId: string; attemptCount: number
}>

const MAX_CALLS = 32
const MAX_OUTPUT_BYTES = 1_048_576
const MAX_JSON_NODES = 20_000
const MAX_ATTEMPT_COUNT = 1_000_000
const ROOT_KEYS = ["evidence", "jobs", "nextCursor", "usage"] as const
const JOB_KEYS = ["company", "description", "evidenceRefs", "fullDescription", "id", "location", "logo", "salary", "source", "title", "url"] as const
const USAGE_KEYS = ["aiCalls", "durationMs", "estimatedCostUsd", "jobsFailed", "jobsProcessed", "jobsSucceeded", "ledgerKey", "providers", "requests", "stepId", "sessionId", "toolCallId", "toolName", "toolVersion", "turnId"] as const

type CallState = { readonly identity: string; terminal?: string; jobIds?: readonly string[] }

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value)) return undefined
    const prototype = Object.getPrototypeOf(value), ownKeys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || ownKeys.length !== keys.length
      || !ownKeys.every((key): key is string => typeof key === "string" && keys.includes(key))) return undefined
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined
    }
    return value as Record<string, unknown>
  } catch { return undefined }
}

type JsonBudget = { nodes: number; serializedBytes: number }

function addSerializedBytes(budget: JsonBudget, bytes: number): boolean {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_OUTPUT_BYTES - budget.serializedBytes) return false
  budget.serializedBytes += bytes
  return true
}

function addJsonString(value: string, budget: JsonBudget): boolean {
  if (!addSerializedBytes(budget, 1)) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    let bytes: number
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) bytes = 2
    else if (code <= 0x1f) bytes = 6
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) { bytes = 4; index += 1 }
      else bytes = 6
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes = 6
    else if (code <= 0x7f) bytes = 1
    else if (code <= 0x7ff) bytes = 2
    else bytes = 3
    if (!addSerializedBytes(budget, bytes)) return false
  }
  return addSerializedBytes(budget, 1)
}

function countNode(budget: JsonBudget): boolean {
  if (budget.nodes >= MAX_JSON_NODES) return false
  budget.nodes += 1
  return true
}

function safeJson(value: unknown, seen = new Set<object>(), depth = 0, budget: JsonBudget = { nodes: 0, serializedBytes: 0 }): boolean {
  if (value === null) return countNode(budget) && addSerializedBytes(budget, 4)
  if (typeof value === "string") return countNode(budget) && addJsonString(value, budget)
  if (typeof value === "boolean") return countNode(budget) && addSerializedBytes(budget, value ? 4 : 5)
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !countNode(budget)) return false
    const serialized = JSON.stringify(value)
    return typeof serialized === "string" && addSerializedBytes(budget, Buffer.byteLength(serialized, "utf8"))
  }
  if (typeof value !== "object" || nodeTypes.isProxy(value) || seen.has(value) || depth > 32 || !countNode(budget)) return false
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_JSON_NODES - budget.nodes || !addSerializedBytes(budget, 1)) return false
      const keys = Reflect.ownKeys(value)
      if (keys.length !== value.length + 1 || !keys.includes("length")) return false
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0 && !addSerializedBytes(budget, 1)) return false
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor?.enumerable || !("value" in descriptor) || !safeJson(descriptor.value, seen, depth + 1, budget)) return false
      }
      return keys.every(key => key === "length" || typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length)
        && addSerializedBytes(budget, 1)
    }
    const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value)
    if (prototype !== Object.prototype && prototype !== null || !keys.every((key): key is string => typeof key === "string")
      || keys.length > MAX_JSON_NODES - budget.nodes || !addSerializedBytes(budget, 1)) return false
    budget.nodes += keys.length
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index] as string
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)
        || index > 0 && !addSerializedBytes(budget, 1)
        || !addJsonString(key, budget) || !addSerializedBytes(budget, 1)
        || !safeJson(descriptor.value, seen, depth + 1, budget)) return false
    }
    return addSerializedBytes(budget, 1)
  } catch { return false }
  finally { seen.delete(value) }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

function successfulReceipt(value: unknown, call: LifecycleCall): { jobIds: readonly string[]; fingerprint: string } | undefined {
  if (!safeJson(value)) return undefined
  const output = exactRecord(value, ROOT_KEYS)
  if (!output || !Array.isArray(output.jobs) || output.jobs.length > 50 || !Array.isArray(output.evidence)
    || output.evidence.length > 400 || output.nextCursor !== null
      && (typeof output.nextCursor !== "string" || output.nextCursor.length < 1 || output.nextCursor.length > 512)) return undefined
  const usage = exactRecord(output.usage, USAGE_KEYS) ?? exactRecord(output.usage, [...USAGE_KEYS, "providerFailures"])
  if (!usage || usage.toolName !== "jobs.discover" || usage.toolVersion !== "1" || usage.toolCallId !== call.id
    || usage.sessionId !== call.sessionId || usage.turnId !== call.turnId || usage.stepId !== call.stepId) return undefined
  const countFields = ["requests", "jobsProcessed", "jobsSucceeded", "jobsFailed", "aiCalls", "durationMs"]
  if (countFields.some(key => !Number.isSafeInteger(usage[key]) || Number(usage[key]) < 0 || Number(usage[key]) > MAX_ATTEMPT_COUNT)
    || Object.hasOwn(usage, "providerFailures") && (!Number.isSafeInteger(usage.providerFailures) || Number(usage.providerFailures) < 0 || Number(usage.providerFailures) > MAX_ATTEMPT_COUNT)
    || !Array.isArray(usage.providers) || usage.providers.length > 32
    || usage.providers.some(provider => typeof provider !== "string" || !provider.trim() || provider.length > 80)
    || typeof usage.estimatedCostUsd !== "number" || !Number.isFinite(usage.estimatedCostUsd) || usage.estimatedCostUsd < 0) return undefined
  const ids: string[] = []
  for (const job of output.jobs) {
    const row = exactRecord(job, JOB_KEYS)
    if (!row || !isCanonicalTaskGraphJobId(row.id)) return undefined
    ids.push(row.id)
  }
  const serialized = stableJson(value)
  if (Buffer.byteLength(serialized, "utf8") > MAX_OUTPUT_BYTES) return undefined
  return { jobIds: ids, fingerprint: createHash("sha256").update(serialized).digest("hex") }
}

function validCall(call: LifecycleCall, fence: DiscoveryRecoveryCollectorFence): string | undefined {
  if (call.toolName !== "jobs.discover" || call.toolVersion !== "1"
    || call.taskId !== fence.taskId || call.rootTaskId !== fence.rootTaskId
    || call.sessionId !== fence.sessionId || call.turnId !== fence.turnId
    || typeof call.id !== "string" || !call.id.trim() || call.id.length > 256
    || typeof call.stepId !== "string" || !call.stepId.trim() || call.stepId.length > 256) return undefined
  return JSON.stringify([call.taskId, call.rootTaskId, call.sessionId, call.turnId, call.stepId, call.id])
}

/** Collects only successful persisted receipts from started calls in this fenced lease attempt. */
export function createChildDiscoveryRecoveryCollector(fence: DiscoveryRecoveryCollectorFence): {
  observeLifecycleEvent(event: DiscoveryAttemptLifecycleEvent): void
  recovery(): DiscoveryRecoverySnapshot | undefined
} {
  const calls = new Map<string, CallState>()
  let failedClosed = !Number.isSafeInteger(fence.attemptCount) || fence.attemptCount < 1 || fence.attemptCount > MAX_ATTEMPT_COUNT
  const observeLifecycleEvent = (event: DiscoveryAttemptLifecycleEvent): void => {
    try {
      if (failedClosed || event.call.toolName !== "jobs.discover") return
      const identity = validCall(event.call, fence)
      if (!identity) { failedClosed = true; return }
      const callKey = event.call.id
      let state = calls.get(callKey)
      if (!state) {
        if (event.phase !== "started" || calls.size >= MAX_CALLS) { failedClosed = true; return }
        state = { identity }
        calls.set(callKey, state)
      } else if (state.identity !== identity) { failedClosed = true; return }
      if (event.phase === "started") return
      const receipt = event.phase === "completed" ? successfulReceipt(event.output, event.call) : undefined
      const signature = event.phase === "completed" ? receipt?.fingerprint
        : safeJson(event.output) ? createHash("sha256").update(stableJson(event.output)).digest("hex") : undefined
      if (event.phase !== "completed" && signature && Buffer.byteLength(stableJson(event.output), "utf8") > MAX_OUTPUT_BYTES) { failedClosed = true; return }
      if (state.terminal !== undefined) {
        if (state.terminal !== `${event.phase}:${signature ?? "invalid"}`) failedClosed = true
        return
      }
      if (event.phase === "completed") {
        if (!signature || !receipt) { failedClosed = true; return }
        state.jobIds = receipt.jobIds
      } else if (!signature) { failedClosed = true; return }
      state.terminal = `${event.phase}:${signature}`
    } catch { failedClosed = true }
  }

  const recovery = (): DiscoveryRecoverySnapshot | undefined => {
    if (failedClosed || !Array.from(calls.values()).some(call => call.terminal?.startsWith("completed:"))) return undefined
    const jobIds: string[] = [], seen = new Set<string>()
    let truncated = false
    for (const call of calls.values()) {
      if (!call.terminal?.startsWith("completed:")) continue
      for (const id of call.jobIds ?? []) {
        if (seen.has(id)) continue
        seen.add(id)
        if (jobIds.length < MAX_DISCOVERY_RECOVERY_JOB_IDS) jobIds.push(id)
        else truncated = true
      }
    }
    return parseDiscoveryRecovery({ schemaVersion: DISCOVERY_RECOVERY_SCHEMA_VERSION, attemptCount: fence.attemptCount, jobIds, truncated })
  }
  return { observeLifecycleEvent, recovery }
}
