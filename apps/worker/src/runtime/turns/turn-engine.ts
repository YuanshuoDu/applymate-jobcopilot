import { TurnLeaseError, type TurnLease } from "./lease.js"
import { executionOwnerFence } from "../execution-owner.js"
import { runTurnExecutionLoop } from "./turn-execution-loop.js"
import type { TurnExecutionIdentity, TurnExecutionOptions, TurnExecutionStore } from "./turn-execution-types.js"
import type { TurnEngineOptions, TurnEngineResult } from "./turn-engine-types.js"

/** Root compatibility wrapper. The shared loop is deliberately lease-free. */
export class TurnEngine {
  constructor(private readonly options: TurnEngineOptions) {}

  run(): Promise<TurnEngineResult> {
    if (!this.options.rootTaskId.trim()) throw new TypeError("rootTaskId is required")
    const taskId = this.options.taskId ?? this.options.rootTaskId
    if (taskId !== this.options.rootTaskId) throw new TypeError("Turn taskId must equal rootTaskId")
    const identity = executionOwnerFence({ kind: "turn", taskId, lease: this.options.lease })
    return runTurnExecutionLoop({
      ...this.options,
      rootContextInputId: this.options.rootInputId,
      identity,
      store: bindStore(this.options.store),
      contextBuilder: bindContextBuilder(this.options, identity),
      signalError: () => new TurnLeaseError("lease_lost", "Turn execution stopped after lease loss"),
      isOwnershipLost: (error, signal) => error instanceof TurnLeaseError || signal.aborted,
    })
  }
}

function bindStore(store: TurnEngineOptions["store"]): TurnExecutionStore {
  return {
    startStep: (input) => store.startStep({ ...withoutIdentity(input), owner: input.identity }),
    updateStep: (input) => store.updateStep({ ...withoutIdentity(input), owner: input.identity }),
    waitForUser: store.waitForUser ? (input) => store.waitForUser!({ ...withoutIdentity(input), owner: input.identity }) : undefined,
    stageQuestionUsage: store.stageQuestionUsage ? (input) => {
      if (input.identity.kind !== "turn") throw new TurnLeaseError("lease_lost", "Child execution cannot stage a user question")
      return store.stageQuestionUsage!({ ...withoutIdentity(input), owner: input.identity })
    } : undefined,
    cancelPausedQuestion: store.cancelPausedQuestion ? (input) => {
      if (input.identity.kind !== "turn") throw new TurnLeaseError("lease_lost", "Child execution cannot cancel a user question")
      return store.cancelPausedQuestion!({ ...withoutIdentity(input), owner: input.identity })
    } : undefined,
    waitForQuestion: store.waitForQuestion ? (input) => {
      if (input.identity.kind !== "turn") throw new TurnLeaseError("lease_lost", "Child execution cannot wait for user input")
      return store.waitForQuestion!({ ...withoutIdentity(input), owner: input.identity })
    } : undefined,
    readPendingQuestion: store.readPendingQuestion ? (input) => {
      if (input.identity.kind !== "turn") throw new TurnLeaseError("lease_lost", "Child execution cannot recover a user question")
      return store.readPendingQuestion!({ ...withoutIdentity(input), owner: input.identity })
    } : undefined,
    createItem: (input) => store.createItem({ ...withoutIdentity(input), owner: input.identity }),
    updateItem: (input) => store.updateItem({ ...withoutIdentity(input), owner: input.identity }),
    appendEvent: (input) => store.appendEvent({ ...withoutIdentity(input), owner: input.identity }),
    appendEvents: store.appendEvents ? (inputs) => store.appendEvents!(inputs.map(input => ({ ...withoutIdentity(input), owner: input.identity }))) : undefined,
    recordFinalResponse: store.recordFinalResponse ? (input) => {
      if (input.identity.kind !== "turn") throw new TurnLeaseError("lease_lost", "Child execution cannot persist a Turn final response")
      return store.recordFinalResponse!({ ...withoutIdentity(input), owner: input.identity })
    } : undefined,
  }
}

function bindContextBuilder(options: TurnEngineOptions, identity: TurnExecutionIdentity): TurnExecutionOptions["contextBuilder"] {
  return {
    build: ({ scope, stepId, snapshot, rootInputId, rootContextInputId, taskId, now, steeringMarkerContext, steeringMarkerState }) => options.contextBuilder.build({
      scope,
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      stepId,
      snapshot,
      rootInputId,
      rootContextInputId,
      taskId,
      lease: { ownerId: options.lease.ownerId, leaseVersion: options.lease.leaseVersion, now },
      now,
      steeringMarkerContext,
      steeringMarkerState,
    }),
  }
}

function withoutIdentity<T extends { identity: TurnExecutionIdentity }>(input: T): Omit<T, "identity"> {
  const { identity: _identity, ...rest } = input
  return rest
}

export function createTurnEngineExecutor(base: Omit<TurnEngineOptions, "lease" | "signal">) {
  return (input: { lease: TurnLease; signal: AbortSignal }): Promise<TurnEngineResult> => new TurnEngine({ ...base, ...input }).run()
}

export { createToolRouterExecutor } from "./turn-engine-helpers.js"
