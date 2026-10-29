import { describe, expectTypeOf, it } from "vitest"

import type { ChildWaitClaimRecovery } from "../subagents/child-durable-wait-replay.js"
import type { TurnEngineToolCall } from "./turn-engine-types.js"
import type { TurnExecutionIdentity, TurnExecutionOptions } from "./turn-execution-types.js"

describe("turn execution options type boundary", () => {
  it("re-exports the full options contract with child-only wait recovery hooks", () => {
    expectTypeOf<TurnExecutionOptions["childWaitClaimRecovery"]>()
      .toEqualTypeOf<ChildWaitClaimRecovery | undefined>()
    expectTypeOf<NonNullable<TurnExecutionOptions["childWaitCallStartKey"]>>()
      .parameter(0).toEqualTypeOf<string>()
    expectTypeOf<NonNullable<TurnExecutionOptions["childWaitCallStartKey"]>>()
      .parameter(1).toEqualTypeOf<TurnEngineToolCall>()
    expectTypeOf<NonNullable<TurnExecutionOptions["childWaitCallStartKey"]>>()
      .returns.toEqualTypeOf<string | undefined>()
    expectTypeOf<NonNullable<TurnExecutionOptions["childWaitCallStarted"]>>()
      .parameter(0).toEqualTypeOf<string>()
    expectTypeOf<NonNullable<TurnExecutionOptions["childWaitCallStarted"]>>()
      .parameter(1).toEqualTypeOf<TurnEngineToolCall>()
    expectTypeOf<NonNullable<TurnExecutionOptions["childWaitCallStarted"]>>()
      .parameter(2).toEqualTypeOf<string>()
    expectTypeOf<NonNullable<TurnExecutionOptions["childWaitCallStarted"]>>()
      .returns.toEqualTypeOf<void>()
    expectTypeOf<TurnExecutionOptions["identity"]>().toEqualTypeOf<TurnExecutionIdentity>()
  })
})
