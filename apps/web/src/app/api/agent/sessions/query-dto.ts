import { schemaVersion } from "@jobcopilot/agent-protocol"
import { projectLegacySubAgentTask } from "@/lib/agent/session/subagent-task-compat"

import { toIso, type CursorRow } from "./query-helpers"

const SENSITIVE_KEY = /(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|private[_-]?key|credential|token|answer|(?:full[_-]?)?resume(?:[_-]?(text|content|data))?|cv(?:[_-]?(text|content|data))?|raw[_-]?(content|text))/i
const SENSITIVE_TOKEN = /\bBearer\s+[a-z0-9._~+/=-]{8,}/gi
const SENSITIVE_KEY_TOKEN = /\b(?:sk-|xox[baprs]-)[a-z0-9._~+/=-]{8,}/gi

function redactString(value: string): string {
  return value.replace(SENSITIVE_TOKEN, "Bearer [REDACTED]").replace(SENSITIVE_KEY_TOKEN, "[REDACTED]")
}

function redactValue(value: unknown, key: string | null = null, depth = 0): unknown {
  if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]"
  if (typeof value === "string") return redactString(value)
  if (value === null || typeof value === "number" || typeof value === "boolean") return value
  if (depth >= 6) return "[REDACTED]"
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, null, depth + 1))
  if (typeof value !== "object") return "[REDACTED]"
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactValue(entryValue, entryKey, depth + 1)]))
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function displayText(value: unknown): string {
  const row = record(value)
  if (typeof row.text === "string") return redactString(row.text)
  if (typeof row.body === "string") return redactString(row.body)
  return ""
}

function displayParts(value: unknown): unknown[] {
  const parts = record(value).parts
  if (!Array.isArray(parts)) return []
  return parts.reduce<unknown[]>((result, part) => {
    const item = record(part)
    if (item.type === "text" && typeof item.text === "string") {
      result.push({ type: "text", text: redactString(item.text) })
    } else if (item.type === "attachment_ref") {
      result.push({
        type: "attachment_ref",
        mediaType: typeof item.mediaType === "string" ? redactString(item.mediaType) : "application/octet-stream",
        ...(typeof item.filename === "string" ? { filename: redactString(item.filename) } : {}),
      })
    }
    return result
  }, [])
}

export interface ItemQueryRow extends CursorRow {
  sessionId: string
  turnId: string
  stepId: string | null
  taskId: string | null
  type: string
  status: string
  phase: string | null
  revision: number
  content: unknown
  startedAt: Date | null
  completedAt: Date | null
  updatedAt: Date
}

export function itemDto(row: ItemQueryRow) {
  const raw = record(row.content)
  let content: unknown
  if (row.type === "user_message") content = { parts: displayParts(row.content) }
  else if (row.type === "agent_message") content = { text: displayText(row.content) }
  else if (row.type === "approval_request") content = {
    waitKind: "approval",
    approvalId: typeof raw.approvalId === "string" ? raw.approvalId : null,
    toolCallId: typeof raw.toolCallId === "string" ? raw.toolCallId : null,
    action: typeof raw.action === "string" ? redactString(raw.action) : null,
    title: typeof raw.title === "string" ? redactString(raw.title) : "Approval required",
    body: typeof raw.body === "string" ? redactString(raw.body) : "",
    impact: raw.impact === undefined || raw.impact === null ? null : redactValue(raw.impact),
    expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : null,
    decision: typeof raw.decision === "string" ? raw.decision : null,
    pending: row.status === "started",
  }
  else if (row.type === "question") content = {
    waitKind: "question",
    questionId: typeof raw.questionId === "string" ? raw.questionId : null,
    toolCallId: typeof raw.toolCallId === "string" ? raw.toolCallId : null,
    stage: typeof raw.stage === "string" ? redactString(raw.stage) : null,
    question: typeof raw.question === "string" ? redactString(raw.question) : "",
    options: redactValue(raw.options),
    answerAvailable: raw.answerAvailable === true || row.status === "completed",
    pending: row.status === "started",
  }
  else if (row.type === "tool_call") content = {
    toolCallId: typeof raw.toolCallId === "string" ? raw.toolCallId : null,
    toolName: typeof raw.toolName === "string" ? raw.toolName : null,
    inputAvailable: true,
  }
  else if (row.type === "tool_result") content = {
    toolCallId: typeof raw.toolCallId === "string" ? raw.toolCallId : null,
    errorCode: typeof raw.errorCode === "string" ? raw.errorCode : null,
    outputAvailable: true,
  }
  else content = redactValue(row.content)
  return {
    schemaVersion,
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    stepId: row.stepId,
    taskId: row.taskId,
    type: row.type,
    status: row.status,
    phase: row.phase,
    revision: row.revision,
    content,
    startedAt: toIso(row.startedAt),
    completedAt: toIso(row.completedAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  }
}

export interface TurnQueryRow extends CursorRow {
  id: string
  sessionId: string
  source: string
  status: string
  revision: number
  input: unknown
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
  steps: Array<{ id: string }>
  items: Array<{ id: string }>
}

export function turnDto(row: TurnQueryRow) {
  const input = record(row.input)
  return {
    schemaVersion,
    id: row.id,
    sessionId: row.sessionId,
    source: row.source,
    goal: typeof input.goal === "string" ? redactString(input.goal) : "Process agent task",
    status: row.status,
    revision: row.revision,
    activeStepId: row.steps[0]?.id ?? null,
    finalItemId: row.items[0]?.id ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: toIso(row.completedAt),
  }
}

export interface TaskQueryRow extends CursorRow {
  id: string
  sessionId: string
  role: string
  taskType: string
  status: string
  goal: string
  confidence: number | null
  failureReason: string | null
  result: unknown | null
  createdAt: Date
  updatedAt: Date
}

export function taskDto(row: TaskQueryRow) {
  const legacy = projectLegacySubAgentTask(row)
  return {
    schemaVersion,
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    taskType: row.taskType,
    status: legacy.status,
    goal: redactString(row.goal),
    confidence: row.confidence,
    failureReason: row.failureReason ? redactString(row.failureReason) : null,
    hasResult: row.result !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}
