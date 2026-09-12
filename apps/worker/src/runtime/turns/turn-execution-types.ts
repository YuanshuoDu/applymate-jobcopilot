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
  TurnEngineResult,
  TurnEngineStep,
  TurnEngineStore,
  TurnEngineToolExecutor,
  TurnResumeState,
  TurnEnginePlanExecutionHook,
  TurnEnginePlanExecutionHookResult,
} from "./turn-engine-types.js"
import type { GoalContractRef } from "../planning/goal-plan-contract.js"
import type { PlanRevisionRecoveryDispatcher } from "../planning/plan-revision-receipt.js"
import type { ContextCompactionHook, ContextCompactionSnapshotLoader } from "../context/context-snapshot-compaction-seam.js"

export type TurnEngineCompletionGateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly blocker: string; readonly feedback: string }

export type TurnEngineCompletionGate = (input: {
  readonly identity: TurnExecutionIdentity
  readonly scope: TenantScope
  readonly rootTaskId: string
  readonly stepId: string
  readonly signal: AbortSignal
  readonly now: Date
}) => Promise<TurnEngineCompletionGateResult> | TurnEngineCompletionGateResult

/** Identity is owner normalized; the loop never receives a raw lease. */
export type TurnExecutionIdentity = ExecutionOwnerFence

type StoreInput<K extends keyof TurnEngineStore> = Omit<Parameters<NonNullable<TurnEngineStore[K]>>[0], "owner"> & { identity: TurnExecutionIdentity }

export type TurnExecutionStore = {
  startStep(input: StoreInput<"startStep">): Promise<TurnEngineStep>
  updateStep(input: StoreInput<"updateStep">): Promise<void>
  waitForUser?(input: StoreInput<"waitForUser">): Promise<void>
  createItem(input: StoreInput<"createItem">): Promise<TurnEngineItem>
  updateItem(input: StoreInput<"updateItem">): Promise<TurnEngineItem>
  appendEvent(input: StoreInput<"appendEvent">): Promise<{ id: string }>
  appendEvents?(inputs: readonly StoreInput<"appendEvent">[]): Promise<readonly { id: string }[]>
  recordFinalResponse?(input: StoreInput<"recordFinalResponse">): Promise<void>
}

export type TurnExecutionContextBuilder = {
  build(request: {
    scope: TenantScope
    identity: TurnExecutionIdentity
    stepId: string
    snapshot: StepContextSnapshot
    rootInputId?: string
    now: Date
  }): Promise<StepContext>
}

export type TurnExecutionLifecycle = {
  readonly mapEventType?: (type: string) => string
  readonly persistFinalResponse?: boolean
  readonly emitTurnCompleted?: boolean
}

export type PlanExecutionHookInput = Parameters<TurnEnginePlanExecutionHook>[0]
export type PlanExecutionHookResult = TurnEnginePlanExecutionHookResult

export type TurnExecutionOptions = {
  readonly identity: TurnExecutionIdentity
  readonly scope: TenantScope
  readonly goal: string
  readonly goalRef?: GoalContractRef
  readonly snapshot: StepContextSnapshot
  readonly contextBuilder: TurnExecutionContextBuilder
  readonly store: TurnExecutionStore
  readonly model: ModelAdapter
  readonly tools: readonly unknown[]
  readonly executeTool: TurnEngineToolExecutor
  readonly rootInputId?: string
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
  readonly lifecycle?: TurnExecutionLifecycle
  readonly signalError?: () => Error
  /** Allows a root or child adapter to classify a lost owner without coupling the loop to a lease type. */
  readonly isOwnershipLost?: (error: unknown, signal: AbortSignal) => boolean
  /** Executes accepted plan commands through a server-owned adapter; omitted keeps legacy behavior. */
  readonly executePlan?: TurnEnginePlanExecutionHook
  /** Runtime-owned replay repair seam; normal plan proposals never call it. */
  readonly recoveryDispatcher?: PlanRevisionRecoveryDispatcher
  /** Server-owned barrier required only for the canonical planning execution path. */
  readonly planCompletionRequired?: boolean
  /** P3-27A in-memory recovery bound; durable restore is deferred to P3-27B. */
  readonly planCompletionRecoveryLimit?: number
  readonly completionGate?: TurnEngineCompletionGate
  /** Optional server-owned context compaction hook; omitted preserves legacy behavior. */
  readonly contextCompaction?: ContextCompactionHook
  readonly contextCompactionLoadSnapshot?: ContextCompactionSnapshotLoader
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
