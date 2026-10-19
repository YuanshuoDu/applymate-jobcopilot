import { types as nodeTypes } from "node:util"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { parseTaskGraphResultPage, parseTaskGraphResultPageRequest } from "../subagents/task-graph-result-page-contract.js"
import { parseTaskGraphHistoricalDiscoveryPage, parseTaskGraphHistoricalDiscoveryPageRequest } from "../subagents/task-graph-historical-discovery-page-contract.js"
import { parseTaskGraphDiscoveryRecoveryPage, parseTaskGraphDiscoveryRecoveryPageRequest } from "../subagents/task-graph-discovery-recovery-page-contract.js"
import { prepareLifecycleValue, prepareSafeValue, sanitizeLifecyclePreview, type PreparedLifecycleValue } from "./redaction.js"

const PAGE_KEYS = new Set(["schemaVersion", "trust", "availability", "graphRevision", "reason", "role", "taskStatus", "resultStatus", "totalCount", "evidenceCount", "offset", "nextOffset", "items", "attemptCount", "observation", "verificationStatus", "truncated"])
const INVALID_AGENT_LIST_INPUT = "[invalid agent.list input]"

export function prepareAgentListLifecycleInput(value: unknown, maxBytes: number): { pageRequest: boolean; safeInput: unknown } {
  if (hasModeProperty(value)) {
    const mode = readMode(value)
    if (mode === "historical_discovery") {
      const historical = parseTaskGraphHistoricalDiscoveryPageRequest(value)
      if (historical) return { pageRequest: true, safeInput: sanitizeLifecyclePreview({ mode, ...historical }, maxBytes) }
    } else if (mode === "discovery_recovery") {
      const recovery = parseTaskGraphDiscoveryRecoveryPageRequest(value)
      if (recovery) return { pageRequest: true, safeInput: sanitizeLifecyclePreview(recovery, maxBytes) }
    }
    return { pageRequest: true, safeInput: sanitizeLifecyclePreview(INVALID_AGENT_LIST_INPUT, maxBytes) }
  }
  const request = parseTaskGraphResultPageRequest(value)
  if (request) return { pageRequest: true, safeInput: sanitizeLifecyclePreview(request, maxBytes) }
  const legacy = safeLegacyListInput(value)
  return { pageRequest: false, safeInput: sanitizeLifecyclePreview(legacy ?? INVALID_AGENT_LIST_INPUT, maxBytes) }
}

export function isTaskGraphResultPageLike(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  if (nodeTypes.isProxy(value)) return true
  if (Array.isArray(value)) return false
  try { return Reflect.ownKeys(value).some(key => typeof key === "string" && (PAGE_KEYS.has(key) || key === "sourceToken" || key === "sourceResultStatus")) }
  catch { return true }
}

function safeLegacyListInput(value: unknown): { includeTerminal?: boolean } | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const keys = Reflect.ownKeys(value)
    if (keys.some(key => key !== "includeTerminal")) return null
    const descriptor = Object.getOwnPropertyDescriptor(value, "includeTerminal")
    if (!descriptor) return {}
    if (!descriptor.enumerable || !("value" in descriptor)
      || descriptor.value !== undefined && typeof descriptor.value !== "boolean") return null
    return descriptor.value === undefined ? {} : { includeTerminal: descriptor.value }
  } catch { return null }
}

/** Redacts each strict envelope, then restores only canonical candidate IDs and the opaque history cursor. */
export function prepareTaskGraphResultPageOutput(value: unknown): PreparedLifecycleValue {
  const historical = parseTaskGraphHistoricalDiscoveryPage(value)
  if (historical) return prepareHistoricalDiscoveryPageOutput(historical)
  const recovery = parseTaskGraphDiscoveryRecoveryPage(value)
  if (recovery) return prepareTaskGraphDiscoveryRecoveryPageOutput(recovery)
  const page = parseTaskGraphResultPage(value)
  if (!page) throw new Error("invalid_page")
  const redacted = prepareLifecycleValue(page)
  if (page.availability === "unavailable") return redacted
  const safePage = plainRecord(redacted.safe)
  const safeItems = safePage ? denseArray(safePage.items) : null
  const rootKeys = "availability,evidenceCount,graphRevision,items,nextOffset,offset,resultStatus,role,schemaVersion,taskStatus,totalCount,trust"
  if (!safePage || Object.keys(safePage).sort().join(",") !== rootKeys || !safeItems || safeItems.length !== page.items.length) throw new Error("invalid_redaction")
  const expectedItemKeys = page.role === "scout" ? "evidenceKinds,jobId,source" : "evidenceKinds,jobId,score"
  const items = safeItems.map((item, index) => {
    const row = plainRecord(item)
    if (!row || Object.keys(row).sort().join(",") !== expectedItemKeys) throw new Error("invalid_redaction")
    return { ...row, jobId: page.items[index]!.jobId }
  })
  const restored = prepareSafeValue({ ...safePage, items } as RepositoryJsonValue)
  if (!parseTaskGraphResultPage(restored.safe)) throw new Error("invalid_redaction")
  return restored
}

function prepareHistoricalDiscoveryPageOutput(page: NonNullable<ReturnType<typeof parseTaskGraphHistoricalDiscoveryPage>>): PreparedLifecycleValue {
  const redacted = prepareLifecycleValue(page)
  if (page.availability === "unavailable") {
    if (!parseTaskGraphHistoricalDiscoveryPage(redacted.safe)) throw new Error("invalid_redaction")
    return redacted
  }
  const safePage = plainRecord(redacted.safe)
  const safeItems = safePage ? denseArray(safePage.items) : null
  const rootKeys = "availability,items,nextOffset,observation,offset,schemaVersion,sourceResultStatus,sourceToken,totalCount,truncated,trust,verificationStatus"
  if (!safePage || Object.keys(safePage).sort().join(",") !== rootKeys || !safeItems || safeItems.length !== page.items.length) throw new Error("invalid_redaction")
  const items = safeItems.map((item, index) => {
    const row = plainRecord(item)
    if (!row || Object.keys(row).join(",") !== "jobId") throw new Error("invalid_redaction")
    return { jobId: page.items[index]!.jobId }
  })
  const restored = prepareSafeValue({ ...safePage, sourceToken: page.sourceToken, items } as RepositoryJsonValue)
  if (!parseTaskGraphHistoricalDiscoveryPage(restored.safe)) throw new Error("invalid_redaction")
  return restored
}

function prepareTaskGraphDiscoveryRecoveryPageOutput(page: NonNullable<ReturnType<typeof parseTaskGraphDiscoveryRecoveryPage>>): PreparedLifecycleValue {
  const redacted = prepareLifecycleValue(page)
  if (page.availability === "unavailable") {
    if (!parseTaskGraphDiscoveryRecoveryPage(redacted.safe)) throw new Error("invalid_redaction")
    return redacted
  }
  const safePage = plainRecord(redacted.safe)
  const safeItems = safePage ? denseArray(safePage.items) : null
  const rootKeys = "attemptCount,availability,graphRevision,items,nextOffset,observation,offset,schemaVersion,taskStatus,totalCount,truncated,trust,verificationStatus"
  if (!safePage || Object.keys(safePage).sort().join(",") !== rootKeys || !safeItems || safeItems.length !== page.items.length) throw new Error("invalid_redaction")
  const items = safeItems.map((item, index) => {
    const row = plainRecord(item)
    if (!row || Object.keys(row).sort().join(",") !== "jobId") throw new Error("invalid_redaction")
    return { jobId: page.items[index]!.jobId }
  })
  const restored = prepareSafeValue({ ...safePage, items } as RepositoryJsonValue)
  if (!parseTaskGraphDiscoveryRecoveryPage(restored.safe)) throw new Error("invalid_redaction")
  return restored
}

function hasModeProperty(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value)) return false
  try { return Reflect.ownKeys(value).includes("mode") } catch { return true }
}

function readMode(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value)) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "mode")
    return descriptor?.enumerable && "value" in descriptor ? descriptor.value : undefined
  } catch { return undefined }
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const keys = Reflect.ownKeys(value)
    if (!keys.every((key): key is string => typeof key === "string")) return null
    const result: Record<string, unknown> = {}
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return null
      result[key] = descriptor.value
    }
    return result
  } catch { return null }
}

function denseArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || nodeTypes.isProxy(value)) return null
  try {
    const keys = Reflect.ownKeys(value)
    if (keys.length !== value.length + 1 || !keys.includes("length")) return null
    const result: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !("value" in descriptor)) return null
      result.push(descriptor.value)
    }
    return result
  } catch { return null }
}
