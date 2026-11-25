import type { ObjectiveJobProjectionBarrier } from "./application-task-full-loop.objective-wave-support"

const WAIT_TIMEOUT_MS = 15_000
const WAIT_POLL_MS = 50
const EXIT_TIMEOUT_MS = 10_000
const READY_TIMEOUT_MS = 90_000

export type ObjectiveRestartWorker = Readonly<{
  kill(signal: "SIGKILL"): boolean
  exitCode: number | null
  signalCode: string | null
}>

type ProjectionRestartInput<Worker extends ObjectiveRestartWorker> = Readonly<{
  installBarrier(): Promise<ObjectiveJobProjectionBarrier>
  publishFinalApproval(): Promise<void>
  worker: Worker
  waitForExit(worker: Worker, timeoutMs: number): Promise<boolean>
  assertCommittedResult(phase: "blocked" | "crashed"): Promise<void>
  startExactlyOneWorker(): Worker
  waitUntilReady(worker: Worker, timeoutMs: number): Promise<void>
}>

/** Polls only the one advisory key held by the exact synthetic Job barrier. */
export async function waitForObjectiveProjectionWaiters(
  readCount: () => Promise<number>, expected: 0 | 1,
): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const count = await readCount()
    if (!Number.isSafeInteger(count) || count < 0 || count > 1) {
      throw new Error("objective_wave_projection_barrier_waiter_count_invalid")
    }
    if (count === expected) return
    await delay(Math.min(WAIT_POLL_MS, deadline - Date.now()))
  }
  throw new Error(expected ? "objective_wave_projection_barrier_wait_timeout" : "objective_wave_projection_barrier_unblock_timeout")
}

/** Crashes only the captured fixture Worker after its exact result commits but before Job projection. */
export async function restartObjectiveWorkerAtProjectionBarrier<Worker extends ObjectiveRestartWorker>(
  input: ProjectionRestartInput<Worker>,
): Promise<Worker> {
  let barrier: ObjectiveJobProjectionBarrier | undefined
  let barrierCleaned = false, successor: Worker | undefined
  try {
    barrier = await input.installBarrier()
    await input.publishFinalApproval()
    await barrier.waitUntilBlocked()
    await input.assertCommittedResult("blocked")
    await terminate(input.worker, input.waitForExit)
    await barrier.waitUntilUnblocked()
    await input.assertCommittedResult("crashed")
    await barrier.cleanup()
    barrierCleaned = true
    successor = input.startExactlyOneWorker()
    await input.waitUntilReady(successor, READY_TIMEOUT_MS)
    return successor
  } catch (error) {
    try {
      if (successor) await terminate(successor, input.waitForExit)
      if (barrier && !barrierCleaned) {
        await terminate(input.worker, input.waitForExit)
        await barrier.waitUntilUnblocked()
        await barrier.cleanup()
      }
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "objective_projection_restart_cleanup_failed")
    }
    throw error
  }
}

async function terminate<Worker extends ObjectiveRestartWorker>(
  worker: Worker, waitForExit: (worker: Worker, timeoutMs: number) => Promise<boolean>,
): Promise<void> {
  if (isExited(worker)) return
  if (!worker.kill("SIGKILL") && !isExited(worker)) throw new Error("objective_projection_worker_kill_failed")
  if (!isExited(worker) && !await waitForExit(worker, EXIT_TIMEOUT_MS)) {
    throw new Error("objective_projection_worker_exit_timeout")
  }
  if (!isExited(worker)) throw new Error("objective_projection_worker_exit_unconfirmed")
}

function isExited(worker: ObjectiveRestartWorker): boolean {
  return worker.exitCode !== null || worker.signalCode !== null
}

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
