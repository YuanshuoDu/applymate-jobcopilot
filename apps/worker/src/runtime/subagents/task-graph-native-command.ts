import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"
import type { SubagentTaskStatus } from "./types.js"

/** Normalized public native coordination inputs. The key is command-scoped, not revision-scoped. */
export type TaskGraphNativeSpawnRequest = Readonly<{
  kind: "spawn"
  idempotencyKey: string
  role: string
  taskType: string
  goal: string
  constraints?: readonly string[]
  successCriteria?: readonly string[]
  allowedActions?: readonly string[]
  context?: unknown
  parentTaskId?: string
}>
export type TaskGraphNativeFollowupRequest = Readonly<{
  kind: "followup"
  idempotencyKey: string
  sourceTaskId: string
  goal: string
  constraints?: readonly string[]
  successCriteria?: readonly string[]
  context?: unknown
}>
export type TaskGraphNativeRequest = TaskGraphNativeSpawnRequest | TaskGraphNativeFollowupRequest
export type TaskGraphNativeCommandInput = Readonly<{
  scope: TaskGraphExecutionScope
  request: TaskGraphNativeRequest
}>

/** Server-read follow-up provenance, frozen in the operation receipt and child context. */
export type TaskGraphNativeSourceProvenance = Readonly<{
  taskId: string
  rootTaskId: string
  parentTaskId: string | null
  turnId: string
  role: string
  taskType: string
  status: Extract<SubagentTaskStatus, "completed" | "failed" | "interrupted" | "cancelled" | "closed">
  attemptCount: number
  resultDigest: string
  graphNodeKey: string | null
  origin: "task_graph" | "native_legacy"
}>

/** The child task's stored state is distinct from whether it is ready for dispatch. */
export type TaskGraphNativeChildReceipt = Readonly<{
  taskId: string
  rootTaskId: string
  parentTaskId: string
  path: string
  depth: number
  role: string
  taskType: string
  status: Extract<SubagentTaskStatus, "queued" | "waiting">
}>

export type TaskGraphNativeCommandReceipt = Readonly<{
  status: "accepted" | "duplicate"
  replay: boolean
  operationId: string
  requestFingerprint: string
  graphRevision: number
  nodeKey: string
  /** Outbox intent only; broker publication is a later operation. */
  dispatchDisposition: "pending" | "not_ready"
  child: TaskGraphNativeChildReceipt
  source?: TaskGraphNativeSourceProvenance
}>
