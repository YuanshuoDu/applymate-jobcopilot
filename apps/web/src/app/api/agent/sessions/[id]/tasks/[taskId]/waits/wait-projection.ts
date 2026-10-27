export type WaitTargetStatus =
  | "queued" | "running" | "retrying" | "waiting" | "waiting_for_user"
  | "completed" | "failed" | "interrupted" | "cancelled" | "closed"
  | "passed" | "skipped" | "unknown"

export type AgentTaskWaitTargetDto = Readonly<{
  taskId: string
  label: string | null
  status: WaitTargetStatus
  matched: boolean
}>

export type AgentTaskWaitDto = Readonly<{
  mode: "any" | "all"
  status: "waiting"
  deadlineAt: string
  parentDeadlineAt: string | null
  targets: readonly AgentTaskWaitTargetDto[]
}>

export type AgentTaskWaitResponse = Readonly<{ wait: AgentTaskWaitDto | null }>

export type WaitProjectionScope = Readonly<{
  userId: string
  sessionId: string
  turnId: string
  rootTaskId: string
  parentTaskId: string
  stepId: string
}>

type WaitRow = Readonly<{
  userId: unknown; sessionId: unknown; turnId: unknown; parentTaskId: unknown; stepId: unknown
  targetTaskIds: unknown; matchedTaskIds: unknown; mode: unknown; status: unknown
  deadlineAt: unknown; suspendedAt: unknown; consumedAt: unknown
}>

type TargetRow = Readonly<{
  id: unknown; sessionId: unknown; turnId: unknown; rootTaskId: unknown; parentTaskId: unknown
  role: unknown; taskType: unknown; status: unknown
}>

const MAX_TARGETS = 8
const MAX_TASK_ID_LENGTH = 256
const SAFE_TASK_STATUSES = new Set<WaitTargetStatus>([
  "queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed",
  "interrupted", "cancelled", "closed", "passed", "skipped",
])
// Keep this set identical to durable-subagent-wait-resolver.ts TERMINAL.
const MATCHED_TASK_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled", "closed", "passed", "skipped"])
const WAIT_KEYS = ["userId", "sessionId", "turnId", "parentTaskId", "stepId", "targetTaskIds", "matchedTaskIds", "mode", "status", "deadlineAt", "suspendedAt", "consumedAt"]
const TARGET_KEYS = ["id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "role", "taskType", "status"]

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TASK_ID_LENGTH && value.trim() === value
}

function strictIds(value: unknown, allowEmpty: boolean): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_TARGETS || (!allowEmpty && value.length === 0)
    || value.some((id) => !safeId(id)) || new Set(value).size !== value.length) return null
  return value as string[]
}

export function parseAgentWaitTargetIds(value: unknown): string[] | null {
  return strictIds(value, false)
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function safeStatus(value: unknown): WaitTargetStatus {
  return typeof value === "string" && SAFE_TASK_STATUSES.has(value as WaitTargetStatus)
    ? value as WaitTargetStatus : "unknown"
}

// SubAgentTask.role/taskType are database strings and native spawn accepts
// caller-provided strings. Project only fixed server-owned labels.
const SAFE_ROLES = new Set([
  "scout", "analyst", "prepare", "writer", "reviewer", "auditor", "executor", "application_filler",
])
const SAFE_TASK_TYPES = new Set([
  "application_fill_for_review", "job_discovery", "job_analysis", "scheduled_application_prepare",
  "cover_letter_draft", "cover_letter_review",
])

function safeLabel(role: unknown, taskType: unknown): string | null {
  if (typeof role === "string" && SAFE_ROLES.has(role)) return role
  if (typeof taskType === "string" && SAFE_TASK_TYPES.has(taskType)) return taskType
  return null
}

export function projectCurrentAgentTaskWait(
  waitValue: unknown,
  targetValues: readonly unknown[],
  scope: WaitProjectionScope,
  parentDeadlineValue: Date | null = null,
): AgentTaskWaitDto | null {
  if (parentDeadlineValue !== null && !validDate(parentDeadlineValue)) return null
  const wait = record(waitValue) as WaitRow | null
  if (!wait || !exactKeys(wait, WAIT_KEYS) || wait.userId !== scope.userId || wait.sessionId !== scope.sessionId
    || wait.turnId !== scope.turnId || wait.parentTaskId !== scope.parentTaskId || wait.stepId !== scope.stepId
    || wait.status !== "waiting" || wait.mode !== "any" && wait.mode !== "all"
    || !validDate(wait.deadlineAt) || !validDate(wait.suspendedAt) || wait.consumedAt !== null) return null

  const targetIds = strictIds(wait.targetTaskIds, false)
  const matchedIds = strictIds(wait.matchedTaskIds, true)
  if (!targetIds || !matchedIds || matchedIds.some((id) => !targetIds.includes(id))
    || targetValues.length !== targetIds.length) return null

  const rows = targetValues.map((value) => record(value) as TargetRow | null)
  if (rows.some((row) => !row || !exactKeys(row, TARGET_KEYS) || !safeId(row.id)
    || row.sessionId !== scope.sessionId || row.turnId !== scope.turnId || row.rootTaskId !== scope.rootTaskId
    || row.parentTaskId !== scope.parentTaskId) || new Set(rows.map((row) => row?.id)).size !== targetIds.length
    || targetIds.some((id) => !rows.some((row) => row?.id === id))) return null

  const byId = new Map(rows.map((row) => [row!.id as string, row!]))
  return {
    mode: wait.mode,
    status: "waiting",
    deadlineAt: wait.deadlineAt.toISOString(),
    parentDeadlineAt: parentDeadlineValue?.toISOString() ?? null,
    targets: targetIds.map((taskId) => {
      const target = byId.get(taskId)!
      const status = safeStatus(target.status)
      return { taskId, label: safeLabel(target.role, target.taskType), status, matched: MATCHED_TASK_STATUSES.has(status) }
    }),
  }
}
