import type { ModelAdapter } from "@jobcopilot/agent-model"
import type { PolicyRole, RepositoryJsonValue, TenantScope } from "@jobcopilot/agent-protocol"

import type { ExecutionOwnerFence } from "../execution-owner.js"
import type { StepContext, StepContextSnapshot } from "../context/step-context-builder.js"
import type { BusinessCheck } from "../verifier.js"
import type { TurnBudgetLimits } from "../budget.js"
import type {
  TurnEngineItemPhase,
  TurnEngineItemStatus,
  TurnEngineItemType,
  TurnEngineItem,
  AtomicTurnCompletionResult,
  AtomicTurnNoProgressResult,
  TurnEngineResult,
  TurnEngineStep,
  TurnEngineStore,
  TurnEngineToolExecutor,
  TurnResumeState,
  ToolCallRecovery,
} from "./turn-engine-types.js"
import type { SteeringMarkerContext } from "../context/steering-marker-store.js"
import type { SteeringMarkerPayload } from "../context/steering-marker.js"
import type { NativeSemanticProgressMode, NativeSemanticRejectionCount, NativeSemanticRejectionIdentity } from "./native-semantic-rejection-ledger.js"
import { TASK_GRAPH_FINAL_SUMMARY_BINDING, type TaskGraphFinalSummaryBinding } from "../subagents/task-graph-final-summary-binding.js"
import type { DurableWaitControlReader } from "../tools/coordination-types.js"
import type { RecoveredArchivedWaitControl } from "./turn-execution-wait.js"
import type { TaskGraphDenialCheckpoint } from "./task-graph-terminal-assessment.js"
import type { TurnEngineQueryClient } from "./turn-engine-owner-sql.js"

export const NATIVE_SEMANTIC_NO_PROGRESS: unique symbol = Symbol("native-semantic-no-progress")
export const NATIVE_SEMANTIC_REJECTION: unique symbol = Symbol("native-semantic-rejection")
export const RESET_NATIVE_SEMANTIC_PROGRESS: unique symbol = Symbol("reset-native-semantic-progress")
export const TASK_GRAPH_DENIAL_CHECKPOINT: unique symbol = Symbol("task-graph-denial-checkpoint")
export const READ_TASK_GRAPH_DENIAL_CHECKPOINT: unique symbol = Symbol("read-task-graph-denial-checkpoint")
export const SCHEDULED_PIPELINE_COMPLETION: unique symbol = Symbol("scheduled-pipeline-completion")

export type ScheduledPipelineCompletionDisposition =
  | Readonly<{ status: "completed"; candidateText: string }>
  | Readonly<{ status: "waiting_for_dependency"; waitId: string; candidateText: string }>
  /** Worker-owned deterministic Prepare choice wait. */
  | Readonly<{ status: "waiting_for_user"; waitId: string; candidateText: string }>
  /** A Web-owned question; its ID is never the Worker-owned Prepare choice ID. */
  | Readonly<{ status: "waiting_for_external_user"; externalWaitId: string; scheduledWaitId?: string; candidateText: string }>
  | Readonly<{ status: "blocked"; errorCode: string }>

export function parseScheduledPipelineCompletionDisposition(value: unknown): ScheduledPipelineCompletionDisposition | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const keys = Reflect.ownKeys(value)
    const record = value as Record<string, unknown>
    if (keys.some(key => typeof key !== "string") || keys.some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return !descriptor?.enumerable || !("value" in descriptor)
    })) return null
    if (record.status === "completed" && keys.length === 2 && keys.includes("status") && keys.includes("candidateText")
      && typeof record.candidateText === "string" && record.candidateText.trim().length > 0) {
      return { status: "completed", candidateText: record.candidateText }
    }
    if (record.status === "waiting_for_dependency" && keys.length === 3 && keys.includes("status") && keys.includes("candidateText") && keys.includes("waitId")
      && typeof record.candidateText === "string" && record.candidateText.trim().length > 0
      && typeof record.waitId === "string" && record.waitId.trim() === record.waitId && record.waitId.length > 0 && record.waitId.length <= 128) {
      return { status: "waiting_for_dependency", waitId: record.waitId, candidateText: record.candidateText }
    }
    if (record.status === "waiting_for_user" && keys.length === 3 && keys.includes("status") && keys.includes("candidateText") && keys.includes("waitId")
      && typeof record.candidateText === "string" && record.candidateText.trim().length > 0
      && typeof record.waitId === "string" && record.waitId.trim() === record.waitId && record.waitId.length > 0 && record.waitId.length <= 256) {
      return { status: "waiting_for_user", waitId: record.waitId, candidateText: record.candidateText }
    }
    if (record.status === "waiting_for_external_user"
      && (keys.length === 3 && keys.includes("status") && keys.includes("candidateText") && keys.includes("externalWaitId")
        || keys.length === 4 && keys.includes("status") && keys.includes("candidateText") && keys.includes("externalWaitId") && keys.includes("scheduledWaitId"))
      && typeof record.candidateText === "string" && record.candidateText.trim().length > 0
      && typeof record.externalWaitId === "string" && record.externalWaitId.trim() === record.externalWaitId
      && record.externalWaitId.length > 0 && record.externalWaitId.length <= 256
      && (record.scheduledWaitId === undefined || typeof record.scheduledWaitId === "string"
        && record.scheduledWaitId.trim() === record.scheduledWaitId && record.scheduledWaitId.length > 0 && record.scheduledWaitId.length <= 256
        && record.scheduledWaitId !== record.externalWaitId)) {
      return { status: "waiting_for_external_user", externalWaitId: record.externalWaitId,
        ...(typeof record.scheduledWaitId === "string" ? { scheduledWaitId: record.scheduledWaitId } : {}), candidateText: record.candidateText }
    }
    if (record.status === "blocked" && keys.length === 2 && keys.includes("status") && keys.includes("errorCode")
      && typeof record.errorCode === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(record.errorCode)) {
      return { status: "blocked", errorCode: record.errorCode }
    }
    return null
  } catch { return null }
}

export type TurnEngineCompletionGateResult =
  | ({ readonly ok: true } & { readonly [TASK_GRAPH_FINAL_SUMMARY_BINDING]?: TaskGraphFinalSummaryBinding })
  | ({ readonly ok: false; readonly blocker: string; readonly feedback: string; readonly waitId?: string
      readonly [NATIVE_SEMANTIC_NO_PROGRESS]?: true; readonly [NATIVE_SEMANTIC_REJECTION]?: NativeSemanticRejectionIdentity
      readonly [TASK_GRAPH_DENIAL_CHECKPOINT]?: TaskGraphDenialCheckpoint }
      & { readonly [TASK_GRAPH_FINAL_SUMMARY_BINDING]?: TaskGraphFinalSummaryBinding })

export type TurnEngineCompletionGate = ((input: {
  readonly identity: TurnExecutionIdentity
  readonly scope: TenantScope
  readonly rootTaskId: string
  readonly stepId: string
  /** Exact candidate text that passed the ordinary evidence checks and would be persisted. */
  readonly candidateText: string
  readonly signal: AbortSignal
  readonly now: Date
}) => Promise<TurnEngineCompletionGateResult> | TurnEngineCompletionGateResult) & {
  [RESET_NATIVE_SEMANTIC_PROGRESS]?: () => void
  [READ_TASK_GRAPH_DENIAL_CHECKPOINT]?: (client?: TurnEngineQueryClient) => Promise<TaskGraphDenialCheckpoint | null>
  [SCHEDULED_PIPELINE_COMPLETION]?: (input: {
    readonly identity: TurnExecutionIdentity
    readonly scope: TenantScope
    readonly rootTaskId: string
    readonly stepId: string
    readonly stepOrdinal: number
    /** Exact verified response candidate staged before terminal Turn persistence. */
    readonly candidateText: string
    readonly signal: AbortSignal
    readonly now: Date
    readonly isOwnershipLost?: (error: unknown, signal: AbortSignal) => boolean
  }) => Promise<ScheduledPipelineCompletionDisposition> | ScheduledPipelineCompletionDisposition
}

export type TurnExecutionStepBudget = { readonly remainingTurnSteps?: number }
export type TaskGraphDenialProgress = Readonly<{
  taskId: string
  graphRevision: number
  verificationDigest: string
  inputThroughSequence: bigint
  consumedInputIds: readonly string[]
  count: 1 | 2
}>

/** Identity is owner normalized; the loop never receives a raw lease. */
export type TurnExecutionIdentity = ExecutionOwnerFence

type StoreInput<K extends keyof TurnEngineStore> = Omit<Parameters<NonNullable<TurnEngineStore[K]>>[0], "owner"> & { identity: TurnExecutionIdentity }

export type TurnExecutionStore = {
  startStep(input: StoreInput<"startStep">): Promise<TurnEngineStep>
  updateStep(input: StoreInput<"updateStep">): Promise<void>
  completeNativeSemanticRejectionStep?(input: Omit<Parameters<NonNullable<import("./native-semantic-rejection-ledger.js").NativeSemanticProgressStore["completeNativeSemanticRejectionStep"]>>[0], "owner">
    & { executionIdentity: TurnExecutionIdentity }): Promise<NativeSemanticRejectionCount>
  waitForUser?(input: StoreInput<"waitForUser">): Promise<void>
  stageQuestionUsage?(input: StoreInput<"stageQuestionUsage">): Promise<void>
  cancelPausedQuestion?(input: StoreInput<"cancelPausedQuestion">): ReturnType<NonNullable<TurnEngineStore["cancelPausedQuestion"]>>
  waitForQuestion?(input: StoreInput<"waitForQuestion">): ReturnType<NonNullable<TurnEngineStore["waitForQuestion"]>>
  readPendingQuestion?(input: StoreInput<"readPendingQuestion">): ReturnType<NonNullable<TurnEngineStore["readPendingQuestion"]>>
  createItem(input: StoreInput<"createItem">): Promise<TurnEngineItem>
  updateItem(input: StoreInput<"updateItem">): Promise<TurnEngineItem>
  appendEvent(input: StoreInput<"appendEvent">): Promise<{ id: string }>
  appendEvents?(inputs: readonly StoreInput<"appendEvent">[]): Promise<readonly { id: string }[]>
  recordFinalResponse?(input: StoreInput<"recordFinalResponse">): Promise<void | AtomicTurnCompletionResult | AtomicTurnNoProgressResult>
}

export type TurnExecutionContextBuilder = {
  build(request: {
    scope: TenantScope
    identity: TurnExecutionIdentity
    stepId: string
    snapshot: StepContextSnapshot
    rootInputId?: string
    rootContextInputId?: string
    taskId?: string
    now: Date
    steeringMarkerContext?: SteeringMarkerContext
    steeringMarkerState?: { readonly active: readonly SteeringMarkerPayload[] }
  }): Promise<StepContext>
}

export type TurnExecutionLifecycle = {
  readonly mapEventType?: (type: string) => string
  readonly persistFinalResponse?: boolean
  readonly emitTurnCompleted?: boolean
}

export type TurnExecutionOptions = {
  readonly identity: TurnExecutionIdentity
  readonly scope: TenantScope
  readonly goal: string
  readonly snapshot: StepContextSnapshot
  readonly contextBuilder: TurnExecutionContextBuilder
  readonly store: TurnExecutionStore
  readonly model: ModelAdapter
  readonly outputSchema?: unknown
  readonly tools: readonly unknown[]
  readonly executeTool: TurnEngineToolExecutor
  readonly rootInputId?: string
  /** Read-only durable root context; never participates in claim/checkpoint state. */
  readonly rootContextInputId?: string
  readonly actorRole?: PolicyRole
  readonly capabilities?: readonly string[]
  readonly validateToolArguments?: (toolName: string, input: unknown) => boolean | string
  readonly signal?: AbortSignal
  readonly maxSteps?: number
  readonly now?: () => Date
  readonly idFactory?: (prefix: string) => string
  readonly subscribe?: (event: { id: string; type: string; itemId: string | null; correlationId: string; causationId: string | null; payload: RepositoryJsonValue }) => void | Promise<void>
  readonly publishReasoningSummary?: boolean
  readonly budget?: TurnBudgetLimits
  readonly expectedEvidence?: readonly string[]
  readonly businessChecks?: readonly BusinessCheck[]
  readonly noProgressRepeatLimit?: number
  readonly resume?: TurnResumeState
  readonly toolCallRecovery?: readonly ToolCallRecovery[]
  readonly lifecycle?: TurnExecutionLifecycle
  readonly signalError?: () => Error
  /** Allows a root or child adapter to classify a lost owner without coupling the loop to a lease type. */
  readonly isOwnershipLost?: (error: unknown, signal: AbortSignal) => boolean
  readonly completionGate?: TurnEngineCompletionGate
  readonly nativeSemanticProgressMode?: NativeSemanticProgressMode
  /** Server-restored exact candidate; it is never added to a model request. */
  readonly recoveredFinalCandidate?: string
  /** Canonical replay state used only for server-side marker hydration. */
  readonly steeringMarkerState?: { readonly active: readonly SteeringMarkerPayload[] }
  /** Refresh the owner-scoped TaskGraph before building each planning-enabled Root Step. */
  readonly refreshTaskGraphBeforeStep?: (snapshot: StepContextSnapshot) => Promise<StepContextSnapshot>
  /** Re-read durable TaskGraph state before continuing after an inline-ready agent.wait. */
  readonly refreshTaskGraphAfterReadyWait?: (snapshot: StepContextSnapshot) => Promise<StepContextSnapshot>
  /** Re-read durable TaskGraph state after an accepted agent.plan receipt. */
  readonly refreshTaskGraphAfterPlan?: (snapshot: StepContextSnapshot) => Promise<StepContextSnapshot>
  readonly durableWaitControlReader?: DurableWaitControlReader
  readonly recoveredWaitControl?: RecoveredArchivedWaitControl
}

export type TurnExecutionOutcome = TurnEngineResult

export function executionKey(identity: TurnExecutionIdentity): string {
  return identity.kind === "turn" ? `turn:${identity.turnId}` : `task:${identity.taskId}`
}

/** Prefix every generated identity with its owner so concurrent child work cannot collide. */
export function executionId(identity: TurnExecutionIdentity, prefix: string): string {
  return `${executionKey(identity)}:${prefix}`
}

export type ExecutionItemInput = {
  readonly id: string
  readonly stepId: string | null
  readonly type: TurnEngineItemType
  readonly phase: TurnEngineItemPhase
  readonly content: unknown
  readonly now: Date
}

export type ExecutionItemHandle = { id: string; type: TurnEngineItemType; phase: TurnEngineItemPhase; revision: number }

export type ExecutionItemState = TurnEngineItemStatus
