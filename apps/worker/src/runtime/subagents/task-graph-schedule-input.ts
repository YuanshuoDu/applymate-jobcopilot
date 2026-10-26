import type { RootTaskVerificationRequirementsResolution } from "../context/root-task-objective.js"
import type { TaskGraphProposal, TaskGraphRepairOf } from "../planning/task-graph.js"
import type { TaskGraphBranchReplacement } from "../planning/task-graph-branch-replacement.js"
import type { TaskGraphOperationalFailureReplacement } from "../planning/task-graph-operational-failure-replacement.js"
import type { SubagentTaskStatus } from "./types.js"

/** Lease and lineage supplied by the currently executing parent task. */
export type TaskGraphExecutionScope = Readonly<{
  userId: string
  sessionId: string
  turnId: string
  rootTaskId: string
  parentTaskId: string
  stepId: string
  turnLeaseOwner: string
  turnLeaseVersion: number
  parentLeaseOwner: string
  parentAttemptCount: number
}>
/** Server-owned template data; model input may choose only the registered ID. */
export type TaskGraphTaskTemplate = Readonly<{
  role: string
  taskType: string
  allowedActions: readonly string[]
  constraints?: readonly string[]
  context?: unknown
  expectedOutputSchema?: unknown
  maxAttempts?: number
}>

export type TaskGraphScheduleInput = Readonly<{
  scope: TaskGraphExecutionScope
  proposal: TaskGraphProposal
  templates: Readonly<Record<string, TaskGraphTaskTemplate>>
  /** Additional untrusted acceptance criteria pinned for the active Root. */
  rootSuccessCriteria?: readonly string[]
  /** Present only for the atomic native Root typed-leaf supersession path. */
  replaceUnstarted?: Readonly<{ nodeKey: string }>
  /** Present only for atomic replacement of a complete unstarted typed branch. */
  replaceBranch?: TaskGraphBranchReplacement
  /** Present only for the server-proven typed operational-failure replacement path. */
  replaceOperationalFailure?: TaskGraphOperationalFailureReplacement
  /** Server-resolved from the persisted Turn objective; never populated from model tool input. */
  verificationRequirements?: RootTaskVerificationRequirementsResolution
}>

export type TaskGraphScheduleNode = Readonly<{
  key: string
  taskId: string
  status: Extract<SubagentTaskStatus, "queued" | "waiting">
}>

export type TaskGraphScheduleReceipt = Readonly<{
  status: "accepted" | "duplicate"
  revision: number
  nodes: readonly TaskGraphScheduleNode[]
  readyTaskIds: readonly string[]
}>

/** A choice wait has no scheduled node; accepted receipts describe the later atomic append. */
export type TaskGraphScheduledPrepareReceipt =
  | Readonly<{ status: "waiting_for_choice"; revision: number; nodes: readonly []; readyTaskIds: readonly [];
      choice: Readonly<{ required: true; status: "waiting"; waitId: string }> }>
  | (TaskGraphScheduleReceipt & Readonly<{ choice: Readonly<{ required: true; status: "answered"; waitId: string }>
      | Readonly<{ required: false }> }>)
