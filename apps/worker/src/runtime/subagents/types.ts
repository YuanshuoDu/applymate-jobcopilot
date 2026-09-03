import type pg from "pg"

export const SUBAGENT_LEASE_WINDOW_MS = 60_000
export const SUBAGENT_HEARTBEAT_INTERVAL_MS = 20_000
export const SUBAGENT_MAX_DEPTH = 8
export const SUBAGENT_MAX_FAN_OUT = 8
export const SUBAGENT_DEFAULT_MAX_ATTEMPTS = 3

export type SubagentTaskStatus =
  | "queued"
  | "running"
  | "retrying"
  | "waiting"
  | "waiting_for_user"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled"
  | "closed"

export type SubagentJobPayload = {
  taskId: string
  sessionId: string
  rootTaskId: string
  ownerId: string
}

export function parseSubagentJobPayload(value: unknown): SubagentJobPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(",") !== "ownerId,rootTaskId,sessionId,taskId") return null
  if (![row.taskId, row.sessionId, row.rootTaskId, row.ownerId].every(value => typeof value === "string" && value.trim().length > 0)) return null
  return { taskId: row.taskId as string, sessionId: row.sessionId as string, rootTaskId: row.rootTaskId as string, ownerId: row.ownerId as string }
}

export type SubagentPolicy = {
  maxConcurrency: number
  maxDepth: number
  maxFanOut: number
  maxAttempts: number
}

export type SubagentTaskSpec = {
  userId: string
  sessionId: string
  turnId?: string | null
  parentTaskId?: string | null
  role: string
  taskType: string
  goal: string
  constraints?: readonly string[]
  successCriteria?: readonly string[]
  allowedActions?: readonly string[]
  context?: unknown
  expectedOutputSchema?: unknown
  modelProfileSnapshot?: unknown
  toolPolicySnapshot?: unknown
  budgetSnapshot?: unknown
  policy?: Partial<SubagentPolicy>
}

export type SubagentTaskRecord = {
  id: string
  userId: string
  sessionId: string
  turnId: string | null
  rootTaskId: string
  parentTaskId: string | null
  path: string
  depth: number
  role: string
  taskType: string
  status: SubagentTaskStatus
  goal: string
  constraints: unknown
  successCriteria: unknown
  allowedActions: unknown
  context: unknown
  expectedOutputSchema: unknown
  result: unknown | null
  failureReason: string | null
  attemptCount: number
  maxAttempts: number
  leaseOwner: string | null
  leaseExpiresAt: Date | null
  interruptRequestedAt: Date | null
  budgetSnapshot: unknown
  toolPolicySnapshot: unknown
}

export type SubagentLease = SubagentTaskRecord & {
  ownerId: string
  leaseExpiresAt: Date
  signal: AbortSignal
}

export type SubagentExecutionResult = {
  status: "completed" | "waiting" | "waiting_for_user" | "failed"
  result?: unknown
  failureReason?: string
}

export type SubagentStore = {
  create(input: SubagentTaskSpec & { policy: SubagentPolicy }): Promise<SubagentTaskRecord>
  get(taskId: string, sessionId: string): Promise<SubagentTaskRecord | null>
  claim(input: { taskId: string; sessionId: string; ownerId: string; policy: SubagentPolicy; now: Date }): Promise<SubagentTaskRecord | null>
  heartbeat(input: { taskId: string; sessionId: string; ownerId: string; now: Date }): Promise<"renewed" | "interrupted" | "lost">
  finish(input: { taskId: string; sessionId: string; ownerId: string; status: SubagentExecutionResult["status"]; result?: unknown; failureReason?: string; now: Date }): Promise<"completed" | "retrying" | "failed" | "waiting" | "waiting_for_user" | "interrupted" | null>
  close(input: { taskId: string; sessionId: string; now: Date }): Promise<boolean>
  interruptTree(input: { sessionId: string; rootTaskId: string; now: Date }): Promise<number>
  recoverExpired(input: { now: Date; limit: number }): Promise<SubagentTaskRecord[]>
}

export type PgSubagentPool = Pick<pg.Pool, "connect">

export class SubagentLimitError extends Error {
  constructor(readonly code: "concurrency" | "depth" | "fan_out" | "attempts", message: string) {
    super(message)
    this.name = "SubagentLimitError"
  }
}

export class SubagentLeaseError extends Error {
  constructor(readonly code: "not_available" | "lost", message: string) {
    super(message)
    this.name = "SubagentLeaseError"
  }
}

export const TERMINAL_SUBAGENT_STATUSES: readonly SubagentTaskStatus[] = [
  "completed", "failed", "interrupted", "cancelled", "closed",
]

export function isTerminalSubagentStatus(status: string): status is Extract<SubagentTaskStatus, "completed" | "failed" | "interrupted" | "cancelled" | "closed"> {
  return TERMINAL_SUBAGENT_STATUSES.includes(status as SubagentTaskStatus)
}

export function defaultSubagentPolicy(): SubagentPolicy {
  return {
    maxConcurrency: 4,
    maxDepth: SUBAGENT_MAX_DEPTH,
    maxFanOut: SUBAGENT_MAX_FAN_OUT,
    maxAttempts: SUBAGENT_DEFAULT_MAX_ATTEMPTS,
  }
}

export function normalizeSubagentPolicy(input: Partial<SubagentPolicy> = {}): SubagentPolicy {
  const defaults = defaultSubagentPolicy()
  const result = { ...defaults, ...input }
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`Subagent ${name} must be a positive integer`)
  }
  return result
}

export function inheritSubagentPolicy(parent: SubagentPolicy | null, requested: Partial<SubagentPolicy> = {}): SubagentPolicy {
  const candidate = normalizeSubagentPolicy(requested)
  if (!parent) return candidate
  return {
    maxConcurrency: Math.min(parent.maxConcurrency, candidate.maxConcurrency),
    maxDepth: Math.min(parent.maxDepth, candidate.maxDepth),
    maxFanOut: Math.min(parent.maxFanOut, candidate.maxFanOut),
    maxAttempts: Math.min(parent.maxAttempts, candidate.maxAttempts),
  }
}
