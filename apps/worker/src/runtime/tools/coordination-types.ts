import type { AgentTreeManager } from "../subagents/manager.js"
import type { SubagentTaskRecord } from "../subagents/types.js"
import { ToolExecutionError } from "./types.js"

export type CoordinationTaskView = Pick<SubagentTaskRecord,
  "id" | "userId" | "sessionId" | "turnId" | "rootTaskId" | "parentTaskId" | "path" | "depth" |
  "role" | "taskType" | "status" | "goal" | "attemptCount" | "maxAttempts" | "leaseOwner" |
  "leaseExpiresAt" | "interruptRequestedAt"
>

export type CoordinationMessage = {
  readonly id: string
  readonly sessionId: string
  readonly turnId: string
  readonly fromTaskId: string | null
  readonly toTaskId: string
  readonly kind: string
  readonly idempotencyKey: string
  readonly createdAt: Date
}

export interface CoordinationStore {
  getTask(input: { userId: string; sessionId: string; taskId: string }): Promise<CoordinationTaskView | null>
  listTasks(input: { userId: string; sessionId: string; rootTaskId?: string; includeTerminal: boolean }): Promise<CoordinationTaskView[]>
  sendMessage(input: {
    userId: string
    sessionId: string
    turnId: string
    fromTaskId: string | null
    toTaskId: string
    kind: string
    payload: unknown
    idempotencyKey: string
  }): Promise<{ message: CoordinationMessage; duplicate: boolean }>
  getSpawnReplay(input: { userId: string; sessionId: string; idempotencyKey: string }): Promise<CoordinationTaskView | null>
  /** Records the operation and dispatches the task atomically. */
  recordSpawn(input: { userId: string; sessionId: string; idempotencyKey: string; task: CoordinationTaskView }): Promise<boolean>
  appendActivity(input: CoordinationActivity): Promise<void>
}

export type CoordinationActivity = {
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
  readonly stepId: string
  readonly taskId: string | null
  readonly operation: string
  readonly status: "started" | "completed" | "failed"
  readonly idempotencyKey: string
  readonly data: Record<string, unknown>
}

/** AH2-025 adapter seam. Its implementation must durably suspend and release the Turn lease. */
export interface DurableWaitPort {
  wait(input: {
    userId: string
    sessionId: string
    turnId: string
    stepId: string
    taskId: string | null
    rootTaskId: string | null
    targetTaskIds: readonly string[]
    mode: "any" | "all"
    timeoutMs: number
    idempotencyKey: string
  }): Promise<DurableWaitResult>
  cancel?(input: { userId: string; sessionId: string; taskId: string; reason: "interrupted" | "closed" }): Promise<void>
}

export type DurableWaitResult = {
  readonly waitId: string
  readonly status: "waiting" | "ready" | "timed_out" | "interrupted" | "closed"
  readonly deadlineAt: string
  readonly matchedTaskIds: readonly string[]
}

export type CoordinationRuntimeOptions = {
  readonly manager: AgentTreeManager
  readonly store: CoordinationStore
  readonly wait?: DurableWaitPort
}

export class CoordinationError extends ToolExecutionError {
  constructor(readonly code: string, message: string) {
    super(code, message)
    this.name = "CoordinationError"
  }
}
