import type { AgentTreeManager } from "../subagents/manager.js"
import type { SubagentTaskRecord } from "../subagents/types.js"
import type { TaskGraphCommandPort } from "../subagents/task-graph-command-port.js"
import type { RootTaskVerificationRequirementsResolution } from "../context/root-task-objective.js"
import { ToolExecutionError, type ToolExecutionContext } from "./types.js"

export type CoordinationTaskView = Pick<SubagentTaskRecord,
  "id" | "userId" | "sessionId" | "turnId" | "rootTaskId" | "parentTaskId" | "path" | "depth" |
  "role" | "taskType" | "status" | "goal" | "attemptCount" | "maxAttempts" | "leaseOwner" |
  "leaseExpiresAt" | "interruptRequestedAt"
> & {
  /** Optional server-read evidence; never accepted from model tool input. */
  readonly context?: unknown | null
  readonly result?: unknown | null
  readonly failureReason?: string | null
}

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

/** Durable mailbox state returned by the server-owned pending-read seam. */
export type CoordinationMailboxMessage = CoordinationMessage & {
  readonly payload: unknown
  readonly deliveredAt: Date | null
  readonly consumedAt: Date | null
}

export type CoordinationMailboxConsumeResult = {
  readonly messageIds: readonly string[]
  readonly count: number
}

export type CoordinationMailboxOwnerFence = {
  readonly ownerId: string
  readonly attemptCount: number
  readonly now: Date
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
  /** Optional server-owned mailbox read/consume seam for durable child-context wiring. */
  listPendingMessages?(input: {
    userId: string
    sessionId: string
    toTaskId: string
    limit?: number
  }): Promise<CoordinationMailboxMessage[]>
  consumeMessages?(input: {
    userId: string
    sessionId: string
    toTaskId: string
    messageIds: readonly string[]
    owner: CoordinationMailboxOwnerFence
  }): Promise<CoordinationMailboxConsumeResult>
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
  wait(input: DurableWaitInvocation): Promise<DurableWaitResult>
  cancel?(input: { userId: string; sessionId: string; taskId: string; reason: "interrupted" | "closed" }): Promise<void>
}

/** Original, schema-validated wait request plus current server-owned execution fences. */
export type DurableWaitInvocation = {
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
}

/** A bounded control projection; task details remain in the canonical wait outcome. */
export type DurableWaitControl = {
  readonly waitId: string
  readonly status: "waiting" | "ready" | "timed_out" | "interrupted"
}

export type DurableWaitControlInvocation = DurableWaitInvocation & {
  readonly ownerId: string
  readonly leaseVersion: number
  readonly now: Date
}

export type DurableWaitStepAdmission = "fresh_streaming_root" | "restored_inflight_root"

/** Read-only lookup used only when a completed wait result is an archived reference. */
export interface DurableWaitControlReader {
  readByInvocation(input: DurableWaitControlInvocation, admission: DurableWaitStepAdmission): Promise<DurableWaitControl | null>
}

export type DurableWaitResult = {
  readonly waitId: string
  readonly status: "waiting" | "ready" | "timed_out" | "interrupted" | "closed"
  readonly deadlineAt: string
  readonly matchedTaskIds: readonly string[]
}

/** Runtime-owned TaskGraph command configuration for planner-enabled root delegation. */
export type NativeCoordinationRuntimeOptions = Readonly<{
  enabled: boolean
  commandPort?: TaskGraphCommandPort
  turnLeaseOwner: string
  turnLeaseVersion: number
  parentLeaseOwner: string
  parentAttemptCount: () => number | null | undefined
}>

export type CoordinationRuntimeOptions = {
  readonly manager: AgentTreeManager
  readonly store: CoordinationStore
  readonly wait?: DurableWaitPort
  readonly nativeCoordination?: NativeCoordinationRuntimeOptions
  /** Server-resolved canonical objective requirements; never supplied by a model tool call. */
  readonly verificationRequirements?: RootTaskVerificationRequirementsResolution
}

export class CoordinationError extends ToolExecutionError {
  constructor(readonly code: string, message: string) {
    super(code, message)
    this.name = "CoordinationError"
  }
}

export function assertRootChildCreationUsesCoveragePlan(
  context: ToolExecutionContext,
  requirements: RootTaskVerificationRequirementsResolution | undefined,
): void {
  if (requirements?.status !== "valid" || context.actorRole === "subagent") return
  const currentTaskId = context.taskId
  const currentRootTaskId = context.rootTaskId
  const isRoot = (typeof currentTaskId === "string" && currentTaskId.trim() !== "" && currentTaskId === currentRootTaskId)
    || (context.actorRole === "orchestrator" && (!currentTaskId || !currentRootTaskId))
  if (isRoot) throw new CoordinationError(
    "coordination_objective_requirements_require_plan",
    "Root child work with valid objective requirements must use a coverage-checked agent.plan proposal",
  )
}
