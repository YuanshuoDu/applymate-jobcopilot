import { Buffer } from "node:buffer"
import type { TenantScope } from "@jobcopilot/agent-protocol"

import type { ExecutionOwnerFence } from "../execution-owner.js"
import type { StepContext, StepContextSnapshot } from "../context/step-context-builder.js"
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
} from "./turn-engine-types.js"
import type { SteeringMarkerContext } from "../context/steering-marker-store.js"
import type { SteeringMarkerPayload } from "../context/steering-marker.js"
import type { NativeSemanticRejectionCount, NativeSemanticRejectionIdentity } from "./native-semantic-rejection-ledger.js"
import { TASK_GRAPH_FINAL_SUMMARY_BINDING, type TaskGraphFinalSummaryBinding } from "../subagents/task-graph-final-summary-binding.js"
import type { TaskGraphDenialCheckpoint } from "./task-graph-terminal-assessment.js"
import type { TurnEngineQueryClient } from "./turn-engine-owner-sql.js"
import { TURN_SCHEDULED_GATE_CHOICE_MAX_QUESTION_BYTES, parseTurnQuestionGateChoiceBinding,
  turnScheduledGateChoiceWaitId, type TurnQuestionGateChoiceBinding, type TurnQuestionGateChoiceKind } from "./turn-question-gate-choice-contract.js"

export const NATIVE_SEMANTIC_NO_PROGRESS: unique symbol = Symbol("native-semantic-no-progress")
export const NATIVE_SEMANTIC_REJECTION: unique symbol = Symbol("native-semantic-rejection")
export const RESET_NATIVE_SEMANTIC_PROGRESS: unique symbol = Symbol("reset-native-semantic-progress")
export const TASK_GRAPH_DENIAL_CHECKPOINT: unique symbol = Symbol("task-graph-denial-checkpoint")
export const READ_TASK_GRAPH_DENIAL_CHECKPOINT: unique symbol = Symbol("read-task-graph-denial-checkpoint")
export const SCHEDULED_PIPELINE_COMPLETION: unique symbol = Symbol("scheduled-pipeline-completion")
export const SCHEDULED_PIPELINE_EXISTING_AUDIT_RESUME: unique symbol = Symbol("scheduled-pipeline-existing-audit-resume")

export type ScheduledPipelineCompletionDisposition =
  | Readonly<{ status: "completed"; candidateText: string }>
  | Readonly<{ status: "waiting_for_dependency"; waitId: string; candidateText: string }>
  /** Worker-owned deterministic Prepare choice wait. */
  | Readonly<{ status: "waiting_for_user"; waitId: string; candidateText: string }>
  /** Private, fixed Gate question persisted through the existing Turn question store. */
  | Readonly<{ status: "waiting_for_scheduled_gate_choice"; waitId: string; candidateText: string; question: string; binding: TurnQuestionGateChoiceBinding }>
  /** A Web-owned question; its ID is never the Worker-owned Prepare choice ID. */
  | Readonly<{ status: "waiting_for_external_user"; externalWaitId: string; scheduledWaitId?: string; candidateText: string }>
  | Readonly<{ status: "blocked"; errorCode: string }>

export type ScheduledPipelineExistingAuditResumeDisposition = Readonly<{ status: "not_applicable" }>
  | Readonly<{ status: "waiting_for_dependency"; waitId: string }> | Readonly<{ status: "completed" }>

export function parseScheduledPipelineExistingAuditResumeDisposition(value: unknown): ScheduledPipelineExistingAuditResumeDisposition | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return null
    const keys = Reflect.ownKeys(value), record = value as Record<string, unknown>
    if (keys.some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)
    })) return null
    if (keys.length === 1 && keys[0] === "status" && (record.status === "not_applicable" || record.status === "completed")) return { status: record.status }
    if (record.status === "waiting_for_dependency" && keys.length === 2 && keys.includes("status") && keys.includes("waitId")
      && typeof record.waitId === "string" && record.waitId.trim() === record.waitId && record.waitId.length > 0 && record.waitId.length <= 128) return { status: "waiting_for_dependency", waitId: record.waitId }
    return null
  } catch { return null }
}

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
    if (record.status === "waiting_for_scheduled_gate_choice" && keys.length === 5
      && ["status", "candidateText", "waitId", "question", "binding"].every(key => keys.includes(key))
      && typeof record.candidateText === "string" && record.candidateText.trim().length > 0
      && typeof record.question === "string" && record.question.trim() === record.question
      && Buffer.byteLength(record.question, "utf8") > 0 && Buffer.byteLength(record.question, "utf8") <= TURN_SCHEDULED_GATE_CHOICE_MAX_QUESTION_BYTES
      && typeof record.waitId === "string" && record.waitId.trim() === record.waitId && record.waitId.length > 0 && record.waitId.length <= 256) {
      const binding = parseTurnQuestionGateChoiceBinding(record.binding)
      const question = scheduledGateQuestionText(binding?.kind)
      if (binding && question === record.question && turnScheduledGateChoiceWaitId(binding) === record.waitId) {
        return { status: "waiting_for_scheduled_gate_choice", waitId: record.waitId, candidateText: record.candidateText, question, binding }
      }
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

export function scheduledGateQuestionText(kind: TurnQuestionGateChoiceKind | undefined): string | null {
  return kind === "borderline_match" ? "Some prepared applications are close to your match threshold. How should I handle them?"
    : kind === "weak_cover_letter" ? "A prepared application has a weak cover letter. How should I handle it?" : null
}

export type TurnEngineCompletionGateResult =
  | ({ readonly ok: true } & { readonly [TASK_GRAPH_FINAL_SUMMARY_BINDING]?: TaskGraphFinalSummaryBinding })
  | ({ readonly ok: false; readonly blocker: string; readonly feedback: string; readonly waitId?: string
      readonly [NATIVE_SEMANTIC_NO_PROGRESS]?: true; readonly [NATIVE_SEMANTIC_REJECTION]?: NativeSemanticRejectionIdentity
      readonly [TASK_GRAPH_DENIAL_CHECKPOINT]?: TaskGraphDenialCheckpoint }
      & { readonly [TASK_GRAPH_FINAL_SUMMARY_BINDING]?: TaskGraphFinalSummaryBinding })

type ScheduledPipelineCompletionCallbackInput = Readonly<{
  identity: TurnExecutionIdentity; scope: TenantScope; rootTaskId: string; stepId: string; stepOrdinal: number
  candidateText: string; signal: AbortSignal; now: Date; isOwnershipLost?: (error: unknown, signal: AbortSignal) => boolean
}>
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
  [SCHEDULED_PIPELINE_COMPLETION]?: (input: ScheduledPipelineCompletionCallbackInput) => Promise<ScheduledPipelineCompletionDisposition> | ScheduledPipelineCompletionDisposition
  [SCHEDULED_PIPELINE_EXISTING_AUDIT_RESUME]?: (input: ScheduledPipelineCompletionCallbackInput) => Promise<ScheduledPipelineExistingAuditResumeDisposition> | ScheduledPipelineExistingAuditResumeDisposition
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

export type { TurnExecutionOptions } from "./turn-execution-options.js"

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
