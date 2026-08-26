import type { Redis } from 'ioredis'

export type WorkerRuntimeStatus = 'running' | 'paused'

export type WorkerRuntimeState = Readonly<{
  status: WorkerRuntimeStatus
  updatedAt: string
  actorId: string
  reason: string
  pausedQueues: readonly string[]
}>

export type WorkerControlQueue = Readonly<{
  pause: () => Promise<unknown>
  resume: () => Promise<unknown>
  isPaused: () => Promise<boolean>
}>

type WorkerRuntimeControl = Readonly<{
  pause: (doNotWaitActive?: boolean) => Promise<unknown>
  resume: () => void | Promise<unknown>
}>

export const WORKER_RUNTIME_STATE_KEY = 'admin-control:worker-runtime-state'

/** Bind queue state changes to the BullMQ Worker so pause also stops idle polling. */
export function bindWorkerControl(queue: WorkerControlQueue, worker: WorkerRuntimeControl): WorkerControlQueue {
  return {
    isPaused: () => queue.isPaused(),
    pause: async () => {
      await queue.pause()
      await worker.pause(true)
    },
    resume: async () => {
      await queue.resume()
      await worker.resume()
    },
  }
}

const defaultState: WorkerRuntimeState = Object.freeze({
  status: 'running',
  updatedAt: new Date(0).toISOString(),
  actorId: 'system',
  reason: 'Worker runtime default',
  pausedQueues: Object.freeze([]),
})

let currentState = defaultState

export async function readWorkerRuntimeState(connection: Redis): Promise<WorkerRuntimeState> {
  const raw = await connection.get(WORKER_RUNTIME_STATE_KEY)
  const parsed = parseState(raw)
  currentState = parsed
  return parsed
}

export function getWorkerRuntimeState(): WorkerRuntimeState {
  return currentState
}

export async function pauseWorkerRuntime(
  connection: Redis,
  queues: Readonly<Record<string, WorkerControlQueue>>,
  actorId: string,
  reason: string,
): Promise<WorkerRuntimeState> {
  const previous = await readWorkerRuntimeState(connection)
  const pausedQueues = previous.status === 'paused'
    ? previous.pausedQueues
    : (await Promise.all(Object.entries(queues).map(async ([name, queue]) => (await queue.isPaused()) ? name : null))).filter((name): name is string => Boolean(name))
  const next = createState('paused', actorId, reason, pausedQueues)
  await writeWorkerRuntimeState(connection, next)
  await Promise.all(Object.values(queues).map((queue) => queue.pause()))
  return next
}

export async function resumeWorkerRuntime(
  connection: Redis,
  queues: Readonly<Record<string, WorkerControlQueue>>,
  actorId: string,
  reason: string,
): Promise<WorkerRuntimeState> {
  const previous = await readWorkerRuntimeState(connection)
  if (previous.status !== 'paused') return previous

  const preservedPausedQueues = new Set(previous.pausedQueues)
  await Promise.all(Object.entries(queues).filter(([name]) => !preservedPausedQueues.has(name)).map(([, queue]) => queue.resume()))
  const next = createState('running', actorId, reason, [])
  await writeWorkerRuntimeState(connection, next)
  return next
}

export async function restoreWorkerRuntimeState(
  connection: Redis,
  queues: Readonly<Record<string, WorkerControlQueue>>,
): Promise<WorkerRuntimeState> {
  const state = await readWorkerRuntimeState(connection)
  if (state.status === 'paused') await Promise.all(Object.values(queues).map((queue) => queue.pause()))
  return state
}

async function writeWorkerRuntimeState(connection: Redis, state: WorkerRuntimeState): Promise<void> {
  await connection.set(WORKER_RUNTIME_STATE_KEY, JSON.stringify(state))
  currentState = state
}

function createState(status: WorkerRuntimeStatus, actorId: string, reason: string, pausedQueues: readonly string[]): WorkerRuntimeState {
  return Object.freeze({ status, updatedAt: new Date().toISOString(), actorId, reason, pausedQueues: Object.freeze([...pausedQueues]) })
}

function parseState(raw: string | null): WorkerRuntimeState {
  if (!raw) return defaultState
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if ((value.status !== 'running' && value.status !== 'paused') || typeof value.updatedAt !== 'string' || typeof value.actorId !== 'string' || typeof value.reason !== 'string' || !Array.isArray(value.pausedQueues) || !value.pausedQueues.every((item) => typeof item === 'string')) return defaultState
    return createState(value.status, value.actorId, value.reason, value.pausedQueues)
  } catch {
    return defaultState
  }
}
