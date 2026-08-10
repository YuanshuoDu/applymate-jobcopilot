import { describe, expect, it, vi } from 'vitest'
import {
  WORKER_RUNTIME_STATE_KEY,
  pauseWorkerRuntime,
  readWorkerRuntimeState,
  restoreWorkerRuntimeState,
  resumeWorkerRuntime,
} from './worker-state.js'

function createQueue(paused = false) {
  return { paused, pause: vi.fn(async () => undefined), resume: vi.fn(async () => undefined), isPaused: vi.fn(async () => paused) }
}

function createConnection(value: string | null = null) {
  let stored = value
  return {
    get: vi.fn(async (key: string) => key === WORKER_RUNTIME_STATE_KEY ? stored : null),
    set: vi.fn(async (key: string, next: string) => { if (key === WORKER_RUNTIME_STATE_KEY) stored = next; return 'OK' }),
  }
}

describe('worker runtime state', () => {
  it('pauses every queue and remembers queues already paused', async () => {
    const connection = createConnection()
    const queues = { apply: createQueue(), scout: createQueue(true) }

    const state = await pauseWorkerRuntime(connection as never, queues, 'admin-1', 'Pause worker for maintenance')

    expect(state.status).toBe('paused')
    expect(state.pausedQueues).toEqual(['scout'])
    expect(queues.apply.pause).toHaveBeenCalledOnce()
    expect(queues.scout.pause).toHaveBeenCalledOnce()
  })

  it('resumes only queues that were not paused before the global pause', async () => {
    const connection = createConnection(JSON.stringify({ status: 'paused', updatedAt: new Date().toISOString(), actorId: 'admin-1', reason: 'maintenance window', pausedQueues: ['scout'] }))
    const queues = { apply: createQueue(true), scout: createQueue(true) }

    const state = await resumeWorkerRuntime(connection as never, queues, 'admin-2', 'Resume worker after maintenance')

    expect(state.status).toBe('running')
    expect(queues.apply.resume).toHaveBeenCalledOnce()
    expect(queues.scout.resume).not.toHaveBeenCalled()
  })

  it('restores a persisted pause after a worker restart', async () => {
    const connection = createConnection(JSON.stringify({ status: 'paused', updatedAt: new Date().toISOString(), actorId: 'admin-1', reason: 'maintenance window', pausedQueues: [], }))
    const queues = { apply: createQueue(), scout: createQueue() }

    await expect(restoreWorkerRuntimeState(connection as never, queues)).resolves.toMatchObject({ status: 'paused' })
    expect(queues.apply.pause).toHaveBeenCalledOnce()
    expect(queues.scout.pause).toHaveBeenCalledOnce()
  })

  it('falls back to running for malformed state', async () => {
    const connection = createConnection('{"status":"paused"}')
    await expect(readWorkerRuntimeState(connection as never)).resolves.toMatchObject({ status: 'running' })
  })
})
