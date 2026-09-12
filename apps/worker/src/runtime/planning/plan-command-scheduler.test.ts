import { describe, expect, it } from "vitest"

import type { PlanCommandExecutionRecord } from "./plan-command-executor.js"
import { schedulePlanCommands, type PlanCommandExecutionStep, type PlanCommandSchedulerRuntime } from "./plan-command-scheduler.js"
import type { PlanDispatchCommand } from "./plan-intent-dispatcher.js"

type DelegateCommand = Extract<PlanDispatchCommand, { kind: "delegate" }>
type ExecutableCommand = Parameters<PlanCommandSchedulerRuntime["execute"]>[0]

function delegate(localId: string, dependsOn: readonly string[] = []): DelegateCommand {
  return {
    localId, kind: "delegate", objective: localId, inputRefs: [], dependsOn, successCriteria: ["done"], outputSchemaRef: null,
    call: { id: `call:${localId}`, toolName: "spawn_subagent", toolVersion: "1", input: { idempotencyKey: `idem:${localId}`, role: "scout", taskType: "research", goal: localId, constraints: [], successCriteria: ["done"], allowedActions: ["jobs.search"] } },
  }
}

function step(command: DelegateCommand): PlanCommandExecutionStep {
  const result = { ...command.call, status: "completed" as const, output: { localId: command.localId }, errorCode: null }
  const record: PlanCommandExecutionRecord = { localId: command.localId, kind: command.kind, dependsOn: [...command.dependsOn], result }
  return { record, waiting: false }
}

function runtime(execute: PlanCommandSchedulerRuntime["execute"], observed: string[]): PlanCommandSchedulerRuntime {
  return { outputs: new Map(), parallelDelegateLimit: 2, execute, observe: async record => { observed.push(record.localId) }, storeOutput: () => undefined, invalidPlan: message => { throw new Error(message) } }
}

describe("schedulePlanCommands", () => {
  it("dispatches a bounded ready layer concurrently and unlocks dependent work afterward", async () => {
    let active = 0
    let peak = 0
    const calls: string[] = []
    const observed: string[] = []
    const execute = async (command: ExecutableCommand) => {
      if (command.kind !== "delegate") throw new Error("unexpected command kind")
      calls.push(command.localId)
      active++
      peak = Math.max(peak, active)
      await Promise.resolve()
      active--
      return step(command)
    }
    const result = await schedulePlanCommands([delegate("first"), delegate("second"), delegate("dependent", ["first"])], runtime(execute, observed))
    expect(result.status).toBe("completed")
    expect(peak).toBe(2)
    expect(calls).toEqual(["first", "second", "dependent"])
    expect(observed).toEqual(["first", "second", "dependent"])
  })

  it("keeps the default scheduler path serial", async () => {
    let active = 0
    let peak = 0
    const observed: string[] = []
    const execute = async (command: ExecutableCommand) => {
      if (command.kind !== "delegate") throw new Error("unexpected command kind")
      active++
      peak = Math.max(peak, active)
      await Promise.resolve()
      active--
      return step(command)
    }
    const serial = runtime(execute, observed)
    const result = await schedulePlanCommands([delegate("first"), delegate("second")], { ...serial, parallelDelegateLimit: undefined })
    expect(result.status).toBe("completed")
    expect(peak).toBe(1)
    expect(observed).toEqual(["first", "second"])
  })
})
