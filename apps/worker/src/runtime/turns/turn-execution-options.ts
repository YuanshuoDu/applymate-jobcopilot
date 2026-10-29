import type { ModelAdapter } from "@jobcopilot/agent-model"
import type { PolicyRole, RepositoryJsonValue, TenantScope } from "@jobcopilot/agent-protocol"

import type { StepContextSnapshot } from "../context/step-context-builder.js"
import type { SteeringMarkerPayload } from "../context/steering-marker.js"
import type { TurnBudgetLimits } from "../budget.js"
import type { BusinessCheck } from "../verifier.js"
import type { DurableWaitControlReader } from "../tools/coordination-types.js"
import type { RecoveredArchivedWaitControl } from "./turn-execution-wait.js"
import type { ToolCallRecovery, TurnEngineToolCall, TurnEngineToolExecutor, TurnResumeState } from "./turn-engine-types.js"
import type { NativeSemanticProgressMode } from "./native-semantic-rejection-ledger.js"
import type { TurnExecutionIdentity, TurnExecutionContextBuilder, TurnExecutionStore, TurnExecutionLifecycle, TurnEngineCompletionGate } from "./turn-execution-types.js"
import type { ChildWaitClaimRecovery, ChildWaitOrphanRecovery } from "../subagents/child-durable-wait-replay.js"

export type TurnExecutionOptions = {
  readonly identity: TurnExecutionIdentity
  readonly scope: TenantScope
  readonly goal: string
  readonly snapshot: StepContextSnapshot
  readonly contextBuilder: TurnExecutionContextBuilder
  readonly preflightDiscoveryPersonaMemory?: (stepIds: readonly string[]) => Promise<void>
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
  readonly childWaitCallStartKey?: (stepId: string, call: TurnEngineToolCall) => string | undefined
  readonly childWaitCallStarted?: (stepId: string, call: TurnEngineToolCall, eventId: string) => void
  readonly childWaitClaimRecovery?: ChildWaitClaimRecovery
  readonly childWaitOrphanRecovery?: ChildWaitOrphanRecovery
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
