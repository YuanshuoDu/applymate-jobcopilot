import { randomUUID } from 'node:crypto'
import type { Request, Response } from 'express'
import { agentRunQueue } from '../queue/agent-run-queue.js'
import { applyQueue, connection } from '../queue/apply-queue.js'
import { scoutQueue } from '../queue/scout-queue.js'
import { verifyWorkerCommand } from './control-auth.js'

const queues = { 'apply-tasks': applyQueue, 'scout-tasks': scoutQueue, 'agent-runs': agentRunQueue }

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
      if (command.action === 'apply_ats_policy') return response.json({ receipt: randomUUID(), acknowledgedVersion: command.params.version })
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
