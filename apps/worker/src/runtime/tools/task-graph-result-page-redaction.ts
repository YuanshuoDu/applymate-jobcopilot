import { types as nodeTypes } from "node:util"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { parseTaskGraphResultPage, parseTaskGraphResultPageRequest } from "../subagents/task-graph-result-page-contract.js"
import { prepareLifecycleValue, prepareSafeValue, sanitizeLifecyclePreview, type PreparedLifecycleValue } from "./redaction.js"

const PAGE_KEYS = new Set(["schemaVersion", "trust", "availability", "graphRevision", "reason", "role", "taskStatus", "resultStatus", "totalCount", "evidenceCount", "offset", "nextOffset", "items"])
const INVALID_AGENT_LIST_INPUT = "[invalid agent.list input]"

export function prepareAgentListLifecycleInput(value: unknown, maxBytes: number): { pageRequest: boolean; safeInput: unknown } {
  const request = parseTaskGraphResultPageRequest(value)
  if (request) return { pageRequest: true, safeInput: sanitizeLifecyclePreview(request, maxBytes) }
  const legacy = safeLegacyListInput(value)
  return { pageRequest: false, safeInput: sanitizeLifecyclePreview(legacy ?? INVALID_AGENT_LIST_INPUT, maxBytes) }
}

export function isTaskGraphResultPageLike(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  if (nodeTypes.isProxy(value)) return true
  if (Array.isArray(value)) return false
  try { return Reflect.ownKeys(value).some(key => typeof key === "string" && PAGE_KEYS.has(key)) }
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

/** Redacts the complete strict envelope, then restores only canonical item job IDs. */
export function prepareTaskGraphResultPageOutput(value: unknown): PreparedLifecycleValue {
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
