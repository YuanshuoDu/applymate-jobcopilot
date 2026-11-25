import { describe, expect, it, vi } from "vitest"
import type { ObjectiveJobProjectionBarrier } from "./application-task-full-loop.objective-wave-support"
import {
  restartObjectiveWorkerAtProjectionBarrier,
  waitForObjectiveProjectionWaiters,
  type ObjectiveRestartWorker,
} from "./application-task-full-loop.objective-restart-support"

function barrier(events: string[], options: { failCleanup?: boolean; failWait?: boolean } = {}): ObjectiveJobProjectionBarrier {
  return {
    readWaiterCount: async () => { events.push("read-waiters"); return 0 },
    waitUntilBlocked: async () => {
      events.push("blocked")
      if (options.failWait) throw new Error("objective_wave_projection_barrier_wait_timeout")
    },
    waitUntilUnblocked: async () => { events.push("unblocked") },
    release: async () => { events.push("release") },
    cleanup: async () => {
      events.push("cleanup")
      if (options.failCleanup) throw new Error("trigger cleanup failed")
    },
  }
}

type FakeWorker = ObjectiveRestartWorker & Readonly<{ markExited(): void }>

function worker(events: string[], name: string): FakeWorker {
  const state: { exitCode: number | null; signalCode: string | null } = { exitCode: null, signalCode: null }
  return {
    get exitCode() { return state.exitCode },
    get signalCode() { return state.signalCode },
    kill(signal) { events.push(`${name}:${signal}`); return true },
    markExited() { state.signalCode = "SIGKILL" },
  }
}

function input(events: string[], options: { failBlocked?: boolean; failWait?: boolean; failReady?: boolean;
  failCleanup?: boolean; failReceiver?: boolean } = {}) {
  const original = worker(events, "first")
  const successor = worker(events, "second")
  const projectionBarrier = barrier(events, { failCleanup: options.failCleanup, failWait: options.failWait })
  const waitForExit = vi.fn(async (child: FakeWorker) => {
    events.push(child === original ? "first-exit" : "second-exit")
    child.markExited()
    return true
  })
  return {
    original,
    successor,
    waitForExit,
    args: {
      installBarrier: async () => { events.push("install"); return projectionBarrier },
      publishFinalApproval: async () => { events.push("approve") },
      waitForReceiver: async () => {
        events.push("receiver")
        if (options.failReceiver) throw new Error("objective_wave_receiver_wait_timeout")
      },
      worker: original,
      waitForExit,
      assertCommittedResult: async (phase: "blocked" | "crashed") => {
        events.push(`result-${phase}`)
        if (phase === "blocked" && options.failBlocked) throw new Error("receipt check failed")
      },
      ...(options.failWait || options.failReceiver ? { captureWaitTimeout: async ({ waiterCount, workerAlive }: { waiterCount: number; workerAlive: boolean }) => {
        events.push("diagnostic")
        return { available: true, waiterCount, workerAlive, attemptState: "submitted" }
      } } : {}),
      startExactlyOneWorker: () => { events.push("spawn"); return successor },
      waitUntilReady: async (_worker: FakeWorker, timeoutMs: number) => {
        events.push("ready")
        expect(timeoutMs).toBe(90_000)
        if (options.failReady) throw new Error("readiness failed")
      },
    },
  }
}

describe("Objective projection restart support", () => {
  it("installs before approval and restarts once only after the blocked result survives SIGKILL", async () => {
    const events: string[] = []
    const scenario = input(events)
    const result = await restartObjectiveWorkerAtProjectionBarrier(scenario.args)
    expect(result).toBe(scenario.successor)
    expect(events).toEqual([
      "install", "approve", "receiver", "blocked", "result-blocked", "first:SIGKILL", "first-exit",
      "unblocked", "result-crashed", "cleanup", "spawn", "ready",
    ])
    expect(scenario.waitForExit).toHaveBeenCalledOnce()
  })

  it("kills the blocked Worker and cleans the barrier without starting a successor when proof fails", async () => {
    const events: string[] = []
    const scenario = input(events, { failBlocked: true })
    await expect(restartObjectiveWorkerAtProjectionBarrier(scenario.args)).rejects.toThrow("receipt check failed")
    expect(events).toEqual([
      "install", "approve", "receiver", "blocked", "result-blocked", "first:SIGKILL", "first-exit", "unblocked", "cleanup",
    ])
  })

  it("kills a partially started successor if readiness fails", async () => {
    const events: string[] = []
    const scenario = input(events, { failReady: true })
    await expect(restartObjectiveWorkerAtProjectionBarrier(scenario.args)).rejects.toThrow("readiness failed")
    expect(events.slice(-3)).toEqual(["ready", "second:SIGKILL", "second-exit"])
  })

  it("preserves both the original proof failure and cleanup failure", async () => {
    const events: string[] = []
    const scenario = input(events, { failBlocked: true, failCleanup: true })
    let failure: unknown
    try { await restartObjectiveWorkerAtProjectionBarrier(scenario.args) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([
      new Error("receipt check failed"), new Error("trigger cleanup failed"),
    ])
    expect(events).not.toContain("spawn")
  })

  it("captures the bounded boundary before killing the Worker on a waiter timeout", async () => {
    const events: string[] = []
    const scenario = input(events, { failWait: true })
    await expect(restartObjectiveWorkerAtProjectionBarrier(scenario.args)).rejects.toThrow(
      'objective_wave_projection_barrier_wait_timeout:{"available":true,"waiterCount":0,"workerAlive":true,"attemptState":"submitted"}',
    )
    expect(events).toEqual(["install", "approve", "receiver", "blocked", "read-waiters", "diagnostic", "first:SIGKILL", "first-exit", "unblocked", "cleanup"])
  })

  it("reports a distinct receiver timeout and cleans the barrier without starting a successor", async () => {
    const events: string[] = []
    const scenario = input(events, { failReceiver: true })
    await expect(restartObjectiveWorkerAtProjectionBarrier(scenario.args)).rejects.toThrow(
      'objective_wave_receiver_wait_timeout:{"available":true,"waiterCount":0,"workerAlive":true,"attemptState":"submitted"}',
    )
    expect(events).toEqual([
      "install", "approve", "receiver", "read-waiters", "diagnostic", "first:SIGKILL", "first-exit", "unblocked", "cleanup",
    ])
    expect(events).not.toContain("blocked")
    expect(events).not.toContain("spawn")
  })

  it("waits for the exact expected waiter count and rejects ambiguous counts", async () => {
    const reads = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1)
    const waiting = waitForObjectiveProjectionWaiters(reads, 1)
    await new Promise(resolve => setTimeout(resolve, 60))
    await waiting
    await expect(waitForObjectiveProjectionWaiters(async () => 2, 1)).rejects
      .toThrow("objective_wave_projection_barrier_waiter_count_invalid")
  })
})
