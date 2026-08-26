import { randomUUID } from 'node:crypto'
import type { Request, Response } from 'express'
import { getPool } from '../db/apply-results.js'
import { isAtsSourceKey } from '@jobcopilot/shared'
import { loadEffectiveAtsPolicy } from './ats-policy.js'
import { verifyWorkerCommand } from './control-auth.js'
import { bindWorkerControl, getWorkerRuntimeState, pauseWorkerRuntime, readWorkerRuntimeState, resumeWorkerRuntime, WORKER_RUNTIME_STATE_KEY } from './worker-state.js'

const loopbackAdminHosts = new Set(['127.0.0.1', '::1', 'localhost'])
const DEAD_LETTER_QUEUE_NAME = 'dead-letter'
const workerStartedAt = new Date().toISOString()

type WorkerAdminHostOptions = {
  host?: string
  hasControlSecret?: boolean
}

class WorkerControlError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export function resolveWorkerAdminHost(options: WorkerAdminHostOptions = {}): string {
  const configuredHost = options.host ?? process.env.WORKER_ADMIN_HOST
  const host = configuredHost === undefined ? '127.0.0.1' : configuredHost.trim()
  const hasControlSecret = options.hasControlSecret ?? Boolean(process.env.WORKER_CONTROL_SECRET?.trim())

  if (!host) {
    throw new Error('WORKER_ADMIN_HOST must not be empty')
  }
  if (!loopbackAdminHosts.has(host.toLowerCase()) && !hasControlSecret) {
    throw new Error('WORKER_CONTROL_SECRET is required for a non-loopback worker control listener')
  }

  return host
}

export async function applyAtsPolicyCommand(
  pool: ReturnType<typeof getPool>,
  params: Record<string, string | number | boolean>,
): Promise<{ acknowledgedVersion: number }> {
  const sourceKey = typeof params.sourceKey === 'string' ? params.sourceKey : ''
  const version = typeof params.version === 'number' ? params.version : -1
  if (!isAtsSourceKey(sourceKey) || !Number.isInteger(version) || version < 1) {
    throw new WorkerControlError('Invalid ATS policy command', 400)
  }
  let policy
  try {
    policy = await loadEffectiveAtsPolicy(pool, sourceKey)
  } catch {
    throw new WorkerControlError('ATS policy is unavailable', 503)
  }
  if (!policy.configured || policy.version !== version) {
    throw new WorkerControlError('Requested ATS policy version is not committed', 409)
  }
  return { acknowledgedVersion: policy.version }
}

export function createWorkerControlHandler() {
  return async (request: Request, response: Response) => {
    const secret = process.env.WORKER_CONTROL_SECRET
    const rawBody = typeof request.body === 'string' ? request.body : ''
    if (!secret) return response.status(401).json({ error: 'Unauthorized worker command' })
    const command = verifyWorkerCommand(rawBody, request.header('x-worker-control-signature'), secret)
    if (!command) return response.status(401).json({ error: 'Unauthorized or stale worker command' })
    const { connection } = await loadWorkerQueueResources()
    const nonce = await connection.set(`admin-control:${command.nonce}`, '1', 'PX', 300_000, 'NX')
    if (nonce !== 'OK') return response.status(409).json({ error: 'Replayed worker command' })
    try {
      if (command.action === 'queue_summary') {
        const state = await readWorkerRuntimeState(connection)
        return response.json({ receipt: randomUUID(), worker: workerHealth(state), queues: await queueSummary() })
      }
      if (command.action === 'apply_ats_policy') {
        try {
          return response.json({ receipt: randomUUID(), ...await applyAtsPolicyCommand(getPool(), command.params) })
        } catch (error) {
          if (error instanceof WorkerControlError) return response.status(error.status).json({ error: error.message })
          throw error
        }
      }
      const { queues, controls, deadLetterQueue } = await loadWorkerQueueResources()
      if (command.action === 'dead_letter_jobs') {
        const jobs = await deadLetterQueue.getJobs(['waiting', 'delayed', 'failed'], 0, 49, true)
        return response.json({ receipt: randomUUID(), queue: DEAD_LETTER_QUEUE_NAME, jobs: jobs.map(job => ({ ...job.data, id: job.id })) })
      }
      if (command.action === 'retry_dead_letter_job') {
        const deadLetterId = typeof command.params.deadLetterId === 'string' ? command.params.deadLetterId : ''
        if (!deadLetterId) return response.status(400).json({ error: 'Missing dead-letter job id' })
        const deadLetterJob = await deadLetterQueue.getJob(deadLetterId)
        if (!deadLetterJob) return response.status(404).json({ error: 'Dead-letter job not found' })
        const record = deadLetterJob.data as { sourceQueue?: string; sourceJobId?: string }
        const sourceQueue = queues[record.sourceQueue as keyof typeof queues]
        if (!sourceQueue || !record.sourceJobId) return response.status(409).json({ error: 'Original queue is unavailable' })
        const sourceJob = await sourceQueue.getJob(record.sourceJobId)
        if (!sourceJob) return response.status(404).json({ error: 'Original failed job is no longer available' })
        await sourceJob.retry('failed')
        await deadLetterJob.remove()
        return response.json({ receipt: randomUUID(), queue: record.sourceQueue, jobId: record.sourceJobId, deadLetterId })
      }
      const queueName = typeof command.params.queue === 'string' ? command.params.queue : ''
      if (command.action === 'pause_worker' || command.action === 'resume_worker') {
        const state = command.action === 'pause_worker'
          ? await pauseWorkerRuntime(connection, controls, command.actorId, command.reason)
          : await resumeWorkerRuntime(connection, controls, command.actorId, command.reason)
        return response.json({ receipt: randomUUID(), action: command.action, worker: workerHealth(state) })
      }
      const queue = queues[queueName as keyof typeof queues]
      if (!queue) return response.status(400).json({ error: 'Unsupported queue' })
      if (command.action === 'failed_queue_jobs') {
        const jobs = await queue.getJobs(['failed'], 0, 49, true)
        return response.json({ receipt: randomUUID(), queue: queueName, jobs: jobs.map(job => ({ id: job.id, name: job.name, failedReason: job.failedReason, attemptsMade: job.attemptsMade, finishedOn: job.finishedOn })) })
      }
      if (command.action === 'retry_queue_job') {
        const jobId = typeof command.params.jobId === 'string' ? command.params.jobId : ''
        if (!jobId) return response.status(400).json({ error: 'Missing job id' })
        const job = await queue.getJob(jobId)
        if (!job) return response.status(404).json({ error: 'Job not found' })
        await job.retry('failed')
        return response.json({ receipt: randomUUID(), queue: queueName, jobId })
      }
      const state = await readWorkerRuntimeState(connection)
      if (command.action === 'resume_queue' && state.status === 'paused') return response.status(409).json({ error: 'Worker is globally paused' })
      const control = controls[queueName as keyof typeof controls]
      if (command.action === 'pause_queue') {
        await control.pause()
        if (state.status === 'paused' && !state.pausedQueues.includes(queueName)) {
          await connection.set(WORKER_RUNTIME_STATE_KEY, JSON.stringify({ ...state, pausedQueues: [...state.pausedQueues, queueName] }))
        }
      }
      if (command.action === 'resume_queue') await control.resume()
      return response.json({ receipt: randomUUID(), queue: queueName, action: command.action })
    } catch (error) {
      console.error('[worker-control] command failed', { action: command.action, requestId: command.requestId })
      return response.status(503).json({ error: error instanceof Error ? error.message : 'Worker command failed' })
    }
  }
}

async function queueSummary() {
  const { queues, deadLetterQueue } = await loadWorkerQueueResources()
  const stuckThresholdMs = Number(process.env.WORKER_STUCK_JOB_MINUTES ?? '30') * 60_000
  const summaries = await Promise.all(Object.entries(queues).map(async ([name, queue]) => {
    const activeJobs = await queue.getJobs(['active'], 0, 49, true)
    const stuckJobIds = activeJobs.filter((job) => Date.now() - (job.processedOn ?? job.timestamp) > stuckThresholdMs).map((job) => String(job.id)).slice(0, 10)
    return { name, counts: await queue.getJobCounts('active', 'completed', 'delayed', 'failed', 'paused', 'prioritized', 'waiting'), paused: await queue.isPaused(), stuckActiveCount: stuckJobIds.length, stuckJobIds }
  }))
  return [...summaries, {
    name: DEAD_LETTER_QUEUE_NAME,
    counts: await deadLetterQueue.getJobCounts('active', 'completed', 'delayed', 'failed', 'paused', 'prioritized', 'waiting'),
    paused: false,
    stuckActiveCount: 0,
    stuckJobIds: [],
  }]
}

function workerHealth(state = getWorkerRuntimeState()) {
  return { status: state.status === 'paused' ? 'paused' : 'ok', state: state.status, workerId: process.env.WORKER_ID ?? `worker-${process.pid}`, version: process.env.RELEASE_SHA ?? 'unknown', startedAt: workerStartedAt, uptimeSeconds: Math.floor(process.uptime()), pid: process.pid }
}

async function loadWorkerQueueResources() {
  const [agentRunQueueModule, applyQueueModule, scoutQueueModule] = await Promise.all([
    import('../queue/agent-run-queue.js'),
    import('../queue/apply-queue.js'),
    import('../queue/scout-queue.js'),
  ])
  const { deadLetterQueue } = await import('../queue/dead-letter.js')

  const queues = {
    'apply-tasks': applyQueueModule.applyQueue,
    'scout-tasks': scoutQueueModule.scoutQueue,
    'agent-runs': agentRunQueueModule.agentRunQueue,
  }

  return {
    connection: applyQueueModule.connection,
    queues,
    controls: {
      'apply-tasks': bindWorkerControl(queues['apply-tasks'], applyQueueModule.applyWorker),
      'scout-tasks': bindWorkerControl(queues['scout-tasks'], scoutQueueModule.scoutWorker),
      'agent-runs': bindWorkerControl(queues['agent-runs'], agentRunQueueModule.agentRunWorker),
    },
    deadLetterQueue,
  }
}
