import { TurnLeaseError, type TurnLease } from "./lease.js"
import { executionOwnerFence } from "../execution-owner.js"
import { runTurnExecutionLoop } from "./turn-execution-loop.js"
import type { TurnExecutionIdentity, TurnExecutionOptions, TurnExecutionStore } from "./turn-execution-types.js"
import type { TurnEngineOptions, TurnEngineResult } from "./turn-engine-types.js"

/** Root compatibility wrapper. The shared loop is deliberately lease-free. */
export class TurnEngine {
  constructor(private readonly options: TurnEngineOptions) {}

  run(): Promise<TurnEngineResult> {
    const taskId = this.options.taskId ?? this.options.rootTaskId ?? this.options.lease.turnId
    const identity = executionOwnerFence({ kind: "turn", taskId, lease: this.options.lease })
    return runTurnExecutionLoop({
      ...this.options,
      identity,
      store: bindStore(this.options.store, this.options.lease),
      contextBuilder: bindContextBuilder(this.options, identity),
      signalError: () => new TurnLeaseError("lease_lost", "Turn execution stopped after lease loss"),
      isOwnershipLost: (error, signal) => error instanceof TurnLeaseError || signal.aborted,
    })
  }
}

function bindStore(store: TurnEngineOptions["store"], lease: TurnLease): TurnExecutionStore {
  return {
    startStep: (input) => store.startStep({ ...withoutIdentity(input), lease }),
    updateStep: (input) => store.updateStep({ ...withoutIdentity(input), lease }),
    waitForUser: store.waitForUser ? (input) => store.waitForUser!({ ...withoutIdentity(input), lease }) : undefined,
    createItem: (input) => store.createItem({ ...withoutIdentity(input), lease }),
    updateItem: (input) => store.updateItem({ ...withoutIdentity(input), lease }),
    appendEvent: (input) => store.appendEvent({ ...withoutIdentity(input), lease }),
    recordFinalResponse: store.recordFinalResponse ? (input) => store.recordFinalResponse!({ ...withoutIdentity(input), lease }) : undefined,
  }
}

function bindContextBuilder(options: TurnEngineOptions, identity: TurnExecutionIdentity): TurnExecutionOptions["contextBuilder"] {
  return {
    build: ({ scope, stepId, snapshot, rootInputId, now }) => options.contextBuilder.build({
      scope,
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      stepId,
      snapshot,
      rootInputId,
      lease: { ownerId: options.lease.ownerId, leaseVersion: options.lease.leaseVersion, now },
      now,
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
