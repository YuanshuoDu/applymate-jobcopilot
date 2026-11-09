import type { AgentEventRecord, RepositoryJsonValue } from "@jobcopilot/agent-protocol"

import { safeSubagentWaitJson } from "../subagents/subagent-wait-structural-ids.js"
import { toRepositoryJson } from "./turn-engine-types.js"

const WAIT_TOOL_NAMES = new Set(["agent.wait", "wait_subagents"])
const REDACTED_TARGET = "[REDACTED]"
const MAX_EVENT_BYTES = 8 * 1024

/** Projects the full tool-call item content for publication, never the private item row. */
export function projectWaitCallEventContent(content: unknown): RepositoryJsonValue {
  const call = safeDataRecord(content)
  if (!call) return REDACTED_TARGET
  if (!isWaitTool(call.toolName)) return toRepositoryJson(content)
  const toolName = call.toolName
  const projected: Record<string, RepositoryJsonValue> = { toolName, input: projectWaitInput(call.input, toolName) }
  const toolCallId = redactText(call.toolCallId)
  const toolVersion = redactText(call.toolVersion)
  if (toolCallId !== undefined) projected.toolCallId = toolCallId
  if (toolVersion !== undefined) projected.toolVersion = toolVersion
  if (typeof call.status === "string" && ["completed", "failed", "cancelled", "interrupted"].includes(call.status)) projected.status = call.status
  if (call.errorCode === null) projected.errorCode = null
  else {
    const errorCode = redactText(call.errorCode)
    if (errorCode !== undefined) projected.errorCode = errorCode
  }
  return projected
}

/** Projects only the content field of a wait-call item completion event payload. */
export function projectWaitCallCompletionPayload(payload: unknown, expectedItemId?: string | null): RepositoryJsonValue {
  const raw = safeDataRecord(payload)
  const rawContent = raw && safeDataRecord(raw.content)
  const toolName = rawContent?.toolName
  if (!raw || !isWaitTool(toolName)) return toRepositoryJson(payload)
  try {
    const content = projectWaitCallEventContent(rawContent)
    const wrapper: Record<string, RepositoryJsonValue> = { content }
    if (typeof raw.itemId === "string" && (expectedItemId === undefined || raw.itemId === expectedItemId)) wrapper.itemId = raw.itemId
    if (raw.status === "completed") wrapper.status = "completed"
    return wrapper
  } catch {
    return waitPayloadFallback(toolName, expectedItemId)
  }
}

function waitPayloadFallback(toolName: string, expectedItemId?: string | null): RepositoryJsonValue {
  return {
    ...(typeof expectedItemId === "string" ? { itemId: expectedItemId } : {}),
    status: "completed", content: { toolName, input: {} },
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function projectWaitInput(value: unknown, toolName: string): RepositoryJsonValue {
  try {
    const input = safeDataRecord(value)
    if (!input) return {}
    const projected: Record<string, RepositoryJsonValue> = {}
    if (Object.hasOwn(input, "idempotencyKey")) projected.idempotencyKey = REDACTED_TARGET
    if (Object.hasOwn(input, "taskIds")) {
      const ids = input.taskIds
      const maxTargets = toolName === "wait_subagents" ? 8 : 50
      if (Array.isArray(ids) && Number.isSafeInteger(ids.length) && ids.length <= maxTargets) {
        projected.taskIds = Array.from({ length: ids.length }, () => REDACTED_TARGET)
      } else projected.taskIds = REDACTED_TARGET
    }
    if (input.mode === "any" || input.mode === "all") projected.mode = input.mode
    if (Number.isSafeInteger(input.timeoutMs) && Number(input.timeoutMs) >= 1 && Number(input.timeoutMs) <= 30_000) {
      projected.timeoutMs = Number(input.timeoutMs)
    }
    return projected
  } catch { return {} }
}

function redactText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const projected = safeSubagentWaitJson(value, MAX_EVENT_BYTES)
  return typeof projected === "string" ? projected : undefined
}

function safeDataRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (!plainRecord(value)) return null
    const keys = Reflect.ownKeys(value)
    if (keys.some(key => typeof key !== "string")) return null
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return null
    }
    return value
  } catch { return null }
}

/** Safely projects a pending canonical wait-call completion after lineage checks pass. */
export function projectPendingWaitCompletionEvent(event: AgentEventRecord): AgentEventRecord | null {
  const payload = asRecord(event.payload)
  if (!payload) return event
  const content = asRecord(payload.content)
  if (!isWaitTool(content?.toolName)) return event
  const wrapperIdentityMatches = typeof event.itemId === "string" && payload.itemId === event.itemId
    && payload.status === "completed" && event.correlationId === event.itemId
  if (!wrapperIdentityMatches) return null
  return { ...event, payload: projectWaitCallCompletionPayload(payload, event.itemId) }
}

function asRecord(value: RepositoryJsonValue | undefined): Record<string, RepositoryJsonValue> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, RepositoryJsonValue>
    : null
}

function isWaitTool(value: unknown): value is string {
  return typeof value === "string" && WAIT_TOOL_NAMES.has(value)
}
