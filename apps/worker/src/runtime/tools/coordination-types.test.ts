import { describe, expect, expectTypeOf, it } from "vitest"

import type { TaskGraphCommandPort } from "../subagents/task-graph-command-port.js"
import type { CoordinationRuntimeOptions, DurableWaitInvocation, DurableWaitPort, DurableWaitScheduledGateInvocation,
  DurableWaitScheduledGatePort, NativeCoordinationRuntimeOptions } from "./coordination-types.js"

describe("coordination runtime native bridge typing", () => {
  it("keeps the native command port optional for compatibility while fencing its runtime options", () => {
    const legacy: NativeCoordinationRuntimeOptions = {
      enabled: false, turnLeaseOwner: "worker", turnLeaseVersion: 1, parentLeaseOwner: "worker", parentAttemptCount: () => null,
    }
    expect(legacy.commandPort).toBeUndefined()
    expectTypeOf<CoordinationRuntimeOptions["nativeCoordination"]>().toEqualTypeOf<NativeCoordinationRuntimeOptions | undefined>()
    expectTypeOf<NativeCoordinationRuntimeOptions["commandPort"]>().toEqualTypeOf<TaskGraphCommandPort | undefined>()
  })

  it("keeps scheduled Gate admission server-only and derives its matcher inputs", () => {
    expectTypeOf<Extract<keyof DurableWaitPort, "waitScheduledGate">>().toEqualTypeOf<never>()
    expectTypeOf<DurableWaitScheduledGatePort["waitScheduledGate"]>().parameter(0)
      .toEqualTypeOf<Omit<DurableWaitInvocation, "targetTaskIds" | "mode"> & { readonly gateTaskId: string; readonly requestAttemptCount: number }>()
  })
})
