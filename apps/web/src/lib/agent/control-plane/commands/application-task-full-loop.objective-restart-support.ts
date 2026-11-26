import type { ObjectiveJobProjectionBarrier } from "./application-task-full-loop.objective-wave-support"

const WAIT_TIMEOUT_MS = 15_000
const WAIT_POLL_MS = 50
const EXIT_TIMEOUT_MS = 10_000
const READY_TIMEOUT_MS = 90_000
const TIMEOUT_CODES = ["objective_wave_receiver_wait_timeout", "objective_wave_projection_barrier_wait_timeout"] as const
const SAFE_DIAGNOSTIC_BOOLEANS = ["jobProjectionStillPreSubmit", "submitOutboxPublished", "approvalConsumed",
  "resultAttemptMatch", "exactResultReceipt", "exactStartMarker"] as const
const SAFE_DIAGNOSTIC_COUNTS = ["receiverAttempts", "receiverValid", "receiverMalformed", "receiverLineCount",
  "executionStartCount", "executionSettledCount", "resultReceiptCount", "attemptCount", "browserStartCount"] as const
type RestartStage = "install_barrier" | "publish_final_approval" | "wait_for_receiver" | "wait_for_projection"
  | "assert_precrash_result" | "terminate_worker" | "wait_for_unblocked" | "assert_postcrash_result"
  | "cleanup_barrier" | "start_successor" | "wait_successor_ready"
type CleanupStage = "terminate_successor" | "terminate_original" | "wait_for_unblocked" | "cleanup_barrier"
const SAFE_FAILURE_CODES = [
  "objective_wave_receiver_wait_timeout", "objective_wave_worker_exited_before_receiver",
  "objective_wave_receiver_marker_invalid", "objective_wave_projection_barrier_identity_invalid",
  "objective_wave_projection_barrier_key_invalid", "objective_wave_projection_barrier_job_not_preapproval",
  "objective_wave_projection_barrier_lock_missing", "objective_wave_projection_barrier_waiter_count_invalid",
  "objective_wave_projection_barrier_wait_timeout", "objective_wave_projection_barrier_unblock_timeout",
  "objective_projection_worker_kill_failed", "objective_projection_worker_exit_timeout",
  "objective_projection_worker_exit_unconfirmed",
] as const

export type ObjectiveRestartWorker = Readonly<{
  kill(signal: "SIGKILL"): boolean
  exitCode: number | null
  signalCode: string | null
}>

type ProjectionRestartInput<Worker extends ObjectiveRestartWorker> = Readonly<{
  installBarrier(): Promise<ObjectiveJobProjectionBarrier>
  publishFinalApproval(): Promise<void>
  waitForReceiver(): Promise<void>
  worker: Worker
  waitForExit(worker: Worker, timeoutMs: number): Promise<boolean>
  assertCommittedResult(phase: "blocked" | "crashed"): Promise<void>
  captureWaitTimeout?(input: Readonly<{ waiterCount: number; workerAlive: boolean }>):
    Promise<Readonly<Record<string, string | number | boolean | null>>>
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
  let stage: RestartStage = "install_barrier"
  try {
    barrier = await input.installBarrier()
    stage = "publish_final_approval"
    await input.publishFinalApproval()
    stage = "wait_for_receiver"
    try {
      await input.waitForReceiver()
    } catch (error) {
      if (error instanceof Error && error.message === "objective_wave_receiver_wait_timeout") {
        throw await timeoutError(input, barrier, "objective_wave_receiver_wait_timeout")
      }
      throw error
    }
    stage = "wait_for_projection"
    try {
      await barrier.waitUntilBlocked()
    } catch (error) {
      if (error instanceof Error && error.message === "objective_wave_projection_barrier_wait_timeout") {
        throw await timeoutError(input, barrier, "objective_wave_projection_barrier_wait_timeout")
      }
      throw error
    }
    stage = "assert_precrash_result"
    await input.assertCommittedResult("blocked")
    stage = "terminate_worker"
    await terminate(input.worker, input.waitForExit)
    stage = "wait_for_unblocked"
    await barrier.waitUntilUnblocked()
    stage = "assert_postcrash_result"
    await input.assertCommittedResult("crashed")
    stage = "cleanup_barrier"
    await barrier.cleanup()
    barrierCleaned = true
    stage = "start_successor"
    successor = input.startExactlyOneWorker()
    stage = "wait_successor_ready"
    await input.waitUntilReady(successor, READY_TIMEOUT_MS)
    return successor
  } catch (error) {
    let cleanupStage: CleanupStage = "terminate_original"
    try {
      if (successor) {
        cleanupStage = "terminate_successor"
        await terminate(successor, input.waitForExit)
      }
      if (barrier && !barrierCleaned) {
        cleanupStage = "terminate_original"
        await terminate(input.worker, input.waitForExit)
        cleanupStage = "wait_for_unblocked"
        await barrier.waitUntilUnblocked()
        cleanupStage = "cleanup_barrier"
        await barrier.cleanup()
      }
    } catch (cleanupError) {
      const snapshot = timeoutSnapshot(error)
      throw new AggregateError([error, cleanupError], `objective_projection_restart_cleanup_failed:${stage}:${failureCode(error)}:${cleanupStage}:${failureCode(cleanupError)}${snapshot ? `:${snapshot}` : ""}`)
    }
    throw error
  }
}

function failureCode(error: unknown): string {
  if (!(error instanceof Error)) return "other"
  return SAFE_FAILURE_CODES.find(code => error.message === code || error.message.startsWith(`${code}:`)) ?? "other"
}

function timeoutSnapshot(error: unknown): string {
  if (!(error instanceof Error)) return ""
  const code = TIMEOUT_CODES.find(value => error.message.startsWith(`${value}:`))
  if (!code) return ""
  try {
    const parsed: unknown = JSON.parse(error.message.slice(code.length + 1))
    if (!isRecord(parsed) || !validTimeoutSnapshot(parsed)) return ""
    return JSON.stringify(parsed)
  } catch { return "" }
}

function validTimeoutSnapshot(value: Record<string, unknown>): boolean {
  const allowed = new Set<string>(["available", "waiterCount", "workerAlive", ...SAFE_DIAGNOSTIC_BOOLEANS, ...SAFE_DIAGNOSTIC_COUNTS])
  if (Object.keys(value).some(key => !allowed.has(key)) || typeof value.available !== "boolean"
    || typeof value.workerAlive !== "boolean" || !boundedCount(value.waiterCount)) return false
  return SAFE_DIAGNOSTIC_BOOLEANS.every(key => value[key] === undefined || typeof value[key] === "boolean")
    && SAFE_DIAGNOSTIC_COUNTS.every(key => value[key] === undefined || boundedCount(value[key]) || value[key] === null)
}

function boundedCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 2
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

async function timeoutError<Worker extends ObjectiveRestartWorker>(
  input: ProjectionRestartInput<Worker>, barrier: ObjectiveJobProjectionBarrier,
  code: "objective_wave_receiver_wait_timeout" | "objective_wave_projection_barrier_wait_timeout",
): Promise<Error> {
  if (!input.captureWaitTimeout) return new Error(code)
  let source: Readonly<Record<string, string | number | boolean | null>> = { available: false }
  let waiterCount = 2
  const workerAlive = !isExited(input.worker)
  try {
    const rawWaiters = await barrier.readWaiterCount()
    waiterCount = Number.isSafeInteger(rawWaiters) && rawWaiters >= 0 && rawWaiters <= 1 ? rawWaiters : 2
    source = await input.captureWaitTimeout({ waiterCount, workerAlive })
  } catch { /* Keep the original bounded timeout and do not expose diagnostic errors. */ }
  const diagnostic = compactTimeoutSnapshot(source, waiterCount, workerAlive)
  return new Error(`${code}:${JSON.stringify(diagnostic)}`)
}

function compactTimeoutSnapshot(
  source: Readonly<Record<string, string | number | boolean | null>>, waiterCount: number, workerAlive: boolean,
): Readonly<Record<string, boolean | number | null>> {
  const snapshot: Record<string, boolean | number | null> = {
    available: source.available === true, waiterCount, workerAlive,
  }
  for (const key of SAFE_DIAGNOSTIC_BOOLEANS) {
    if (typeof source[key] === "boolean") snapshot[key] = source[key] as boolean
  }
  for (const key of SAFE_DIAGNOSTIC_COUNTS) {
    if (source[key] === null || boundedCount(source[key])) snapshot[key] = source[key] as number | null
  }
  return snapshot
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
