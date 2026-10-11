import { digestNativeVerificationValue } from "./subagents/native-verification-contract.js"
import type { NativeVerificationPort } from "./subagents/native-verification-port.js"
import type { TaskGraphExecutionScope } from "./subagents/task-graph-command-port.js"
import { parseNativeSemanticRejectionIdentity, type NativeSemanticProgressMode, type NativeSemanticRejectionIdentity, type NativeSemanticProgressStore } from "./turns/native-semantic-rejection-ledger.js"
import type { NativeSemanticProgressTracker } from "./native-semantic-progress.js"
import type { TurnExecutionIdentity } from "./turns/turn-execution-types.js"
import { TurnEngineError } from "./turns/turn-engine-types.js"

export async function resolveNativeSemanticProgressMode(input: Readonly<{
  store: NativeSemanticProgressStore
  owner: TurnExecutionIdentity
  requestedEnabled: boolean
  now: Date
}>): Promise<NativeSemanticProgressMode> {
  const resolve = input.store.resolveNativeSemanticProgressMode
  if (!resolve) {
    if (input.requestedEnabled) throw new TurnEngineError("persistence_conflict", "Native semantic progress storage is unavailable")
    return "legacy_v1"
  }
  const mode = await resolve.call(input.store, { owner: input.owner, requestedEnabled: input.requestedEnabled, now: input.now })
  if (mode !== "legacy_v1" && mode !== "durable_v1") throw new TurnEngineError("persistence_conflict", "Native semantic progress mode is invalid")
  return mode
}

export async function observeNativeSemanticRejection(input: Readonly<{
  mode: NativeSemanticProgressMode
  tracker: NativeSemanticProgressTracker
  port: NativeVerificationPort
  store?: Pick<NativeSemanticProgressStore, "readNativeSemanticRejections">
  owner?: TurnExecutionIdentity
  scope: TaskGraphExecutionScope
  stepId: string
  candidateText: string
  controlTaskId: string
}>): Promise<boolean | NativeSemanticRejectionIdentity> {
  if (input.mode === "legacy_v1") return input.tracker.observe(input)
  const reader = input.port.readFailedRootSemanticRejection
  if (!reader) throw new TurnEngineError("persistence_conflict", "Private native rejection readback is unavailable")
  const identity = parseNativeSemanticRejectionIdentity(await reader({ scope: input.scope, candidateText: input.candidateText, controlTaskId: input.controlTaskId }))
  if (!identity) return false
  if (identity.controlTaskId !== input.controlTaskId || identity.candidateDigest !== digestNativeVerificationValue(input.candidateText)) {
    throw new TurnEngineError("persistence_conflict", "Current failed native proof identity is unavailable")
  }
  const store = input.store, read = store?.readNativeSemanticRejections
  if (!read || !store || !input.owner) throw new TurnEngineError("persistence_conflict", "Native semantic rejection history is unavailable")
  const history = await read.call(store, { owner: input.owner, stepId: input.stepId, identity })
  if (typeof history.inputThroughSequence !== "bigint" || history.inputThroughSequence < 0n || !Array.isArray(history.stepIds)
    || history.stepIds.length > 3 || new Set(history.stepIds).size !== history.stepIds.length
    || history.stepIds.some(stepId => typeof stepId !== "string" || !stepId.trim())) {
    throw new TurnEngineError("persistence_conflict", "Native semantic rejection history is invalid")
  }
  if (history.stepIds.length === 3) return true
  return identity
}

export type NativeSemanticProgressConfiguration = Readonly<{
  mode: NativeSemanticProgressMode
  store: NativeSemanticProgressStore
  owner: TurnExecutionIdentity
}>

export function createNativeSemanticRejectionObserver(input: Readonly<{ tracker: NativeSemanticProgressTracker; port: NativeVerificationPort }>) {
  let configuration: NativeSemanticProgressConfiguration | undefined
  return {
    configure(value: NativeSemanticProgressConfiguration) {
      if (value.mode === "durable_v1" && (!value.store.readNativeSemanticRejections || !value.store.completeNativeSemanticRejectionStep || !input.port.readFailedRootSemanticRejection)) {
        throw new TurnEngineError("persistence_conflict", "Native semantic progress storage is unavailable")
      }
      configuration = value
    },
    observe(value: Readonly<{ scope: TaskGraphExecutionScope; stepId: string; candidateText: string; controlTaskId: string }>) {
      const current = configuration
      if (!current) throw new TurnEngineError("persistence_conflict", "Native semantic progress mode is unavailable")
      return observeNativeSemanticRejection({ ...value, ...current, tracker: input.tracker, port: input.port })
    },
    reset() { input.tracker.reset() },
  }
}
