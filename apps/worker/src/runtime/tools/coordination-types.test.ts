import { describe, expect, expectTypeOf, it } from "vitest"

import type { TaskGraphCommandPort } from "../subagents/task-graph-command-port.js"
import { assertRootChildCreationUsesCoveragePlan, CoordinationError } from "./coordination-types.js"
import type { ToolExecutionContext } from "./types.js"
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

describe("root child objective admission", () => {
  const context = (actorRole: "orchestrator" | "subagent" = "orchestrator"): ToolExecutionContext => ({
    scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-1",
    signal: new AbortController().signal, capabilities: [], reportProgress: async () => undefined,
    actorRole, taskId: "root-1", rootTaskId: "root-1",
  })

  it("fails closed for invalid canonical requirements before any child path can proceed", () => {
    for (const role of ["orchestrator", "subagent"] as const) {
      let error: unknown
      try { assertRootChildCreationUsesCoveragePlan(context(role), { status: "invalid" }) } catch (caught) { error = caught }
      expect(error).toBeInstanceOf(CoordinationError)
      expect(error).toMatchObject({ code: "coordination_objective_requirements_invalid" })
    }
  })

  it("keeps absent intent compatible and requires valid Root intent to use a covered plan", () => {
    expect(() => assertRootChildCreationUsesCoveragePlan(context(), undefined)).not.toThrow()
    expect(() => assertRootChildCreationUsesCoveragePlan(context(), { status: "valid", requirements: [] }))
      .toThrowError(expect.objectContaining({ code: "coordination_objective_requirements_require_plan" }))
  })
})
