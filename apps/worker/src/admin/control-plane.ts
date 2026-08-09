import { randomUUID } from 'node:crypto'
import type { Request, Response } from 'express'
import { agentRunQueue } from '../queue/agent-run-queue.js'
import { applyQueue, connection } from '../queue/apply-queue.js'
import { scoutQueue } from '../queue/scout-queue.js'
import { getPool } from '../db/apply-results.js'
import { isAtsSourceKey } from '@jobcopilot/shared'
import { loadEffectiveAtsPolicy } from './ats-policy.js'
import { verifyWorkerCommand } from './control-auth.js'

const queues = { 'apply-tasks': applyQueue, 'scout-tasks': scoutQueue, 'agent-runs': agentRunQueue }

type WorkerAdminHostOptions = {
  host?: string
  environment?: string
  hasControlSecret?: boolean
}

class WorkerControlError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export function resolveWorkerAdminHost(options: WorkerAdminHostOptions = {}): string {
  const host = options.host ?? process.env.WORKER_ADMIN_HOST ?? '127.0.0.1'
  const environment = options.environment ?? process.env.NODE_ENV
  const hasControlSecret = options.hasControlSecret ?? Boolean(process.env.WORKER_CONTROL_SECRET)

  if (environment === 'production' && (host === '0.0.0.0' || host === '::') && !hasControlSecret) {
    throw new Error('WORKER_CONTROL_SECRET is required for a public worker control listener in production')
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
    const nonce = await connection.set(`admin-control:${command.nonce}`, '1', 'PX', 300_000, 'NX')
    if (nonce !== 'OK') return response.status(409).json({ error: 'Replayed worker command' })
    try {
      if (command.action === 'queue_summary') return response.json({ receipt: randomUUID(), queues: await queueSummary() })
      if (command.action === 'apply_ats_policy') {
        try {
          return response.json({ receipt: randomUUID(), ...await applyAtsPolicyCommand(getPool(), command.params) })
        } catch (error) {
          if (error instanceof WorkerControlError) return response.status(error.status).json({ error: error.message })
          throw error
        }
      }
      const queueName = typeof command.params.queue === 'string' ? command.params.queue : ''
      const queue = queues[queueName as keyof typeof queues]
      if (!queue) return response.status(400).json({ error: 'Unsupported queue' })
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
  return Promise.all(Object.entries(queues).map(async ([name, queue]) => ({ name, counts: await queue.getJobCounts('active', 'completed', 'delayed', 'failed', 'paused', 'prioritized', 'waiting'), paused: await queue.isPaused() })))
}
