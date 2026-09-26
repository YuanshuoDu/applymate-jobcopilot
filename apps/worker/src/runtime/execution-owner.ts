import type { SubagentLease } from "./subagents/types.js"
import type { TurnLease } from "./turns/lease.js"

export type TurnExecutionOwner = {
  readonly kind: "turn"
  /** Durable root task that owns this Turn. */
  readonly taskId: string
  readonly lease: TurnLease
}

export type TaskExecutionOwner = {
  readonly kind: "task"
  readonly lease: SubagentLease
}

export type ExecutionOwner = TurnExecutionOwner | TaskExecutionOwner

type ExecutionOwnerFenceBase = {
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
  readonly taskId: string
  readonly rootTaskId: string
  readonly ownerId: string
  readonly leaseExpiresAt: Date
}

export type TurnExecutionOwnerFence = ExecutionOwnerFenceBase & {
  readonly kind: "turn"
  readonly leaseVersion: number
  readonly attemptCount?: never
}

export type TaskExecutionOwnerFence = ExecutionOwnerFenceBase & {
  readonly kind: "task"
  readonly leaseVersion?: never
  readonly attemptCount: number
}

export type ExecutionOwnerFence = TurnExecutionOwnerFence | TaskExecutionOwnerFence

export class ExecutionOwnerError extends Error {
  constructor(message = "Execution owner is invalid") {
    super(message)
    this.name = "ExecutionOwnerError"
  }
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ExecutionOwnerError(`${name} is required`)
  return value
}

function date(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new ExecutionOwnerError("Lease expiry is invalid")
  return value
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new ExecutionOwnerError("Turn lease version is invalid")
  return Number(value)
}

function attempt(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new ExecutionOwnerError("Subagent attempt count is invalid")
  return Number(value)
}

export function executionOwnerFence(owner: ExecutionOwner): ExecutionOwnerFence {
  if (owner.kind === "turn") {
    const lease = owner.lease
    return {
      kind: owner.kind,
      userId: text(lease.userId, "userId"), sessionId: text(lease.sessionId, "sessionId"),
      turnId: text(lease.turnId, "turnId"), taskId: text(owner.taskId, "taskId"), rootTaskId: text(owner.taskId, "rootTaskId"),
      ownerId: text(lease.ownerId, "ownerId"), leaseVersion: version(lease.leaseVersion),
      leaseExpiresAt: date(lease.leaseExpiresAt),
    }
  }

  const lease = owner.lease
  if (lease.turnId === null) throw new ExecutionOwnerError("Subagent lease must belong to a turn")
  if (lease.interruptRequestedAt !== null) throw new ExecutionOwnerError("Subagent lease is interrupted")
  return {
    kind: owner.kind,
    userId: text(lease.userId, "userId"), sessionId: text(lease.sessionId, "sessionId"),
    turnId: text(lease.turnId, "turnId"), taskId: text(lease.id, "taskId"), rootTaskId: text(lease.rootTaskId, "rootTaskId"),
    ownerId: text(lease.ownerId, "ownerId"), attemptCount: attempt(lease.attemptCount),
    leaseExpiresAt: date(lease.leaseExpiresAt),
  }
}
