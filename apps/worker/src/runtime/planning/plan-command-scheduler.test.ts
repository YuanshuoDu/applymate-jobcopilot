import { describe, expect, it, vi } from "vitest"

import type { PlanCommandExecutionRecord, PlanControlRecord } from "./plan-command-executor.js"
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

function failedStep(command: DelegateCommand): PlanCommandExecutionStep {
  const result = { ...command.call, status: "failed" as const, output: undefined, errorCode: "child_failed" }
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

  it("gives the server-owned readiness callback precedence over dependency bookkeeping", async () => {
    const started: string[] = []
    const execute = async (command: ExecutableCommand) => {
      started.push(command.localId)
      return step(command as DelegateCommand)
    }
    const result = await schedulePlanCommands([delegate("dependent", ["first"]), delegate("first")], {
      ...runtime(execute, []), parallelDelegateLimit: undefined, isReady: () => true,
    })
    expect(result.status).toBe("completed")
    expect(started).toEqual(["dependent", "first"])
  })

  it("admits each serial command before starting it", async () => {
    const admissions: number[] = []
    const started: string[] = []
    const execute = async (command: ExecutableCommand) => { started.push(command.localId); return step(command as DelegateCommand) }
    const result = await schedulePlanCommands([delegate("first"), delegate("second")], {
      ...runtime(execute, []), parallelDelegateLimit: undefined, admit: count => admissions.push(count),
    })
    expect(result.status).toBe("completed")
    expect(admissions).toEqual([1, 1])
    expect(started).toEqual(["first", "second"])
  })

  it("admits a parallel batch before starting any sibling", async () => {
    const admissions: number[] = []
    const started: string[] = []
    const execute = async (command: ExecutableCommand) => { started.push(command.localId); return step(command as DelegateCommand) }
    await expect(schedulePlanCommands([delegate("first"), delegate("second")], {
      ...runtime(execute, []), admit: count => { admissions.push(count); throw new Error("plan budget exhausted") },
    })).rejects.toThrow("plan budget exhausted")
    expect(admissions).toEqual([2])
    expect(started).toEqual([])
  })

  it("does not admit replayed commands", async () => {
    const admissions: number[] = []
    const replayed = new Set(["first"])
    const execute = async (command: ExecutableCommand) => step(command as DelegateCommand)
    const result = await schedulePlanCommands([delegate("first"), delegate("second")], {
      ...runtime(execute, []), parallelDelegateLimit: undefined, admit: count => admissions.push(count),
      shouldAdmit: command => !replayed.has(command.localId),
    })
    expect(result.status).toBe("completed")
    expect(admissions).toEqual([1])
  })

  it.each([0, -1, 1.5, 5, Number.NaN, Number.POSITIVE_INFINITY])("rejects an invalid parallel delegate bound (%s) before dispatch", async parallelDelegateLimit => {
    const started: string[] = []
    const invalidPlan = vi.fn((message: string): never => { throw new Error(message) })
    await expect(schedulePlanCommands([delegate("first"), delegate("second")], {
      ...runtime(async command => { started.push(command.localId); return step(command as DelegateCommand) }, []), parallelDelegateLimit, invalidPlan,
    })).rejects.toThrow("Plan parallel delegate bound is invalid")
    expect(invalidPlan).toHaveBeenCalledWith("Plan parallel delegate bound is invalid")
    expect(started).toEqual([])
  })

  it("fails closed before executing an independent prefix of a cyclic graph", async () => {
    const started: string[] = []
    await expect(schedulePlanCommands([delegate("independent"), delegate("first", ["second"]), delegate("second", ["first"])], {
      ...runtime(async command => { started.push(command.localId); return step(command as DelegateCommand) }, []),
    })).rejects.toThrow("Plan dependency graph is invalid")
    expect(started).toEqual([])
  })

  it("does not execute a non-ready command on the serial path", async () => {
    const started: string[] = []
    await expect(schedulePlanCommands([delegate("dependent", ["later"]), delegate("later")], {
      ...runtime(async command => { started.push(command.localId); return step(command as DelegateCommand) }, []), parallelDelegateLimit: undefined,
    })).rejects.toThrow("Plan dependency graph is invalid")
    expect(started).toEqual([])
  })

  it("stores a waiting batch terminal before returning the dependency wait", async () => {
    const stored: string[] = []
    const first = delegate("first")
    const second = delegate("second")
    const result = await schedulePlanCommands([first, second], {
      ...runtime(async command => {
        if (command.kind !== "delegate") throw new Error("unexpected command kind")
        return command.localId === "first" ? { ...step(command), waiting: true } : step(command)
      }, []), storeOutput: record => stored.push(record.localId),
    })
    expect(result.status).toBe("waiting")
    expect(result.waiting?.localId).toBe("first")
    expect(result.completed.map(record => record.localId)).toEqual(["second"])
    expect(stored).toEqual(["first", "second"])
  })

  it("keeps the existing prefix bookkeeping when another parallel sibling fails", async () => {
    const stored: string[] = []
    const result = await schedulePlanCommands([delegate("first"), delegate("second")], {
      ...runtime(async command => command.kind === "delegate" && command.localId === "first" ? failedStep(command) : step(command as DelegateCommand), []),
      storeOutput: record => stored.push(record.localId),
    })
    expect(result).toMatchObject({ status: "failed", failure: { localId: "first" } })
    expect(result.completed).toEqual([])
    expect(stored).toEqual([])
  })

  it("propagates a blocked sibling with its output recorded", async () => {
    const stored: string[] = []
    const blocked: PlanControlRecord = { localId: "blocked", kind: "request_input", dependsOn: [], question: "Need input" }
    const result = await schedulePlanCommands([delegate("first"), delegate("second")], {
      ...runtime(async command => {
        if (command.kind !== "delegate") throw new Error("unexpected command kind")
        return command.localId === "first" ? { ...step(command), blocked } : step(command)
      }, []), storeOutput: record => stored.push(record.localId),
    })
    expect(result.status).toBe("blocked")
    expect(result.blocked).toEqual(blocked)
    expect(result.completed.map(record => record.localId)).toEqual(["first", "second"])
    expect(stored).toEqual(["first", "second"])
  })
})
