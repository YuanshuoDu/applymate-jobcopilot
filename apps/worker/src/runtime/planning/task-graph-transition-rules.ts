import { TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON } from "../subagents/task-graph-child-deadline.js"
import type { TaskGraphEvent, TaskGraphEventType, TaskGraphNodeStatus } from "./task-graph.js"

const ACTIVE_FROM: Readonly<Record<TaskGraphEventType, readonly TaskGraphNodeStatus[]>> = {
  "task.started": ["queued", "retrying", "waiting", "waiting_for_user"],
  "task.queued": ["waiting"], "task.gate_choice_resumed": ["waiting_for_user"],
  "task.waiting": ["running"], "task.waiting_for_user": ["running"], "task.retrying": ["running"],
  "task.completed": ["running"], "task.failed": ["running"],
  "task.interrupted": ["queued", "running", "retrying", "waiting", "waiting_for_user"],
  "task.cancelled": ["queued", "running", "retrying", "waiting", "waiting_for_user"],
  "task.closed": ["queued", "running", "retrying", "waiting", "waiting_for_user"],
}
const NEXT_STATUS: Readonly<Record<TaskGraphEventType, TaskGraphNodeStatus>> = {
  "task.started": "running", "task.queued": "queued", "task.gate_choice_resumed": "queued", "task.waiting": "waiting", "task.waiting_for_user": "waiting_for_user",
  "task.retrying": "queued", "task.completed": "completed", "task.failed": "failed",
  "task.interrupted": "interrupted", "task.cancelled": "cancelled", "task.closed": "closed",
}
const TERMINAL = new Set<TaskGraphNodeStatus>(["completed", "failed", "interrupted", "cancelled", "closed"])
const BLOCKING = new Set<TaskGraphNodeStatus>(["failed", "interrupted", "cancelled", "closed"])
const DEADLINE_EXPIRY_FROM: readonly TaskGraphNodeStatus[] = ["queued", "retrying", "waiting", "waiting_for_user"]

export function taskGraphEventAllowed(status: TaskGraphNodeStatus, type: TaskGraphEventType, failureReason?: string): boolean {
  return ACTIVE_FROM[type].includes(status)
    || type === "task.failed" && failureReason === TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON && DEADLINE_EXPIRY_FROM.includes(status)
}
export function isTaskGraphEventType(value: string): value is TaskGraphEventType { return Object.hasOwn(ACTIVE_FROM, value) }
export function taskGraphNextStatus(type: TaskGraphEventType): TaskGraphNodeStatus { return NEXT_STATUS[type] }
export function isTaskGraphTerminal(status: TaskGraphNodeStatus): boolean { return TERMINAL.has(status) }
export function isTaskGraphBlocking(status: TaskGraphNodeStatus): boolean { return BLOCKING.has(status) }
export function sameTaskGraphEvent(left: TaskGraphEvent, right: TaskGraphEvent): boolean {
  return left.type === right.type && left.idempotencyKey === right.idempotencyKey && left.expectedRevision === right.expectedRevision
    && left.nodeKey === right.nodeKey
    && (left.type !== "task.failed" || right.type === "task.failed" && left.failureReason === right.failureReason)
    && (left.type !== "task.gate_choice_resumed" || right.type === "task.gate_choice_resumed"
      && left.gateTaskId === right.gateTaskId && left.requestAttemptCount === right.requestAttemptCount && left.resumedAttemptCount === right.resumedAttemptCount)
}
