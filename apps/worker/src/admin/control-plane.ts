import { randomUUID } from 'node:crypto'
import type { Request, Response } from 'express'
import { getPool } from '../db/apply-results.js'
import { isAtsSourceKey } from '@jobcopilot/shared'
import { loadEffectiveAtsPolicy } from './ats-policy.js'
import { verifyWorkerCommand } from './control-auth.js'

const loopbackAdminHosts = new Set(['127.0.0.1', '::1', 'localhost'])
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
      if (command.action === 'queue_summary') return response.json({ receipt: randomUUID(), worker: workerHealth(), queues: await queueSummary() })
      if (command.action === 'apply_ats_policy') {
        try {
          return response.json({ receipt: randomUUID(), ...await applyAtsPolicyCommand(getPool(), command.params) })
        } catch (error) {
          if (error instanceof WorkerControlError) return response.status(error.status).json({ error: error.message })
          throw error
        }
      }
      const queueName = typeof command.params.queue === 'string' ? command.params.queue : ''
      const { queues } = await loadWorkerQueueResources()
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
      if (command.action === 'pause_queue') await queue.pause()
      if (command.action === 'resume_queue') await queue.resume()
      return response.json({ receipt: randomUUID(), queue: queueName, action: command.action })
    } catch (error) {
      console.error('[worker-control] command failed', { action: command.action, requestId: command.requestId })
      return response.status(503).json({ error: error instanceof Error ? error.message : 'Worker command failed' })
    }
  }
}

async function queueSummary() {
  const { queues } = await loadWorkerQueueResources()
  const stuckThresholdMs = Number(process.env.WORKER_STUCK_JOB_MINUTES ?? '30') * 60_000
  return Promise.all(Object.entries(queues).map(async ([name, queue]) => {
    const activeJobs = await queue.getJobs(['active'], 0, 49, true)
    const stuckJobIds = activeJobs.filter((job) => Date.now() - (job.processedOn ?? job.timestamp) > stuckThresholdMs).map((job) => String(job.id)).slice(0, 10)
    return { name, counts: await queue.getJobCounts('active', 'completed', 'delayed', 'failed', 'paused', 'prioritized', 'waiting'), paused: await queue.isPaused(), stuckActiveCount: stuckJobIds.length, stuckJobIds }
  }))
}

function workerHealth() {
  return { status: 'ok', workerId: process.env.WORKER_ID ?? `worker-${process.pid}`, version: process.env.RELEASE_SHA ?? 'unknown', startedAt: workerStartedAt, uptimeSeconds: Math.floor(process.uptime()), pid: process.pid }
}

async function loadWorkerQueueResources() {
  const [agentRunQueueModule, applyQueueModule, scoutQueueModule] = await Promise.all([
    import('../queue/agent-run-queue.js'),
    import('../queue/apply-queue.js'),
    import('../queue/scout-queue.js'),
  ])

  return {
    connection: applyQueueModule.connection,
    queues: {
      'apply-tasks': applyQueueModule.applyQueue,
      'scout-tasks': scoutQueueModule.scoutQueue,
      'agent-runs': agentRunQueueModule.agentRunQueue,
    },
  }
}
