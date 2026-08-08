import { createHmac, randomUUID } from 'node:crypto'

export type WorkerControlAction = 'queue_summary' | 'pause_queue' | 'resume_queue' | 'apply_ats_policy'
export type WorkerCommand = Readonly<{ requestId: string; timestamp: number; nonce: string; actorId: string; action: WorkerControlAction; reason: string; params: Record<string, string | number | boolean> }>
export type WorkerCommandResult = Readonly<{
  receipt?: string
  queues?: unknown
  queue?: string
  action?: WorkerControlAction
  acknowledgedVersion?: number
  error?: string
}>

function workerControlConfig() {
  const url = process.env.WORKER_CONTROL_URL
  const secret = process.env.WORKER_CONTROL_SECRET
  return url && secret ? { url: `${url.replace(/\/$/, '')}/internal/admin/control`, secret } : null
}

export async function sendWorkerCommand(command: Omit<WorkerCommand, 'timestamp' | 'nonce'>): Promise<WorkerCommandResult> {
  const config = workerControlConfig()
  if (!config) throw new Error('Worker control plane is not configured')
  const payload: WorkerCommand = { ...command, timestamp: Date.now(), nonce: randomUUID() }
  const body = JSON.stringify(payload)
  const signature = createHmac('sha256', config.secret).update(body).digest('hex')
  const response = await fetch(config.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-worker-control-signature': signature }, body, cache: 'no-store', signal: AbortSignal.timeout(8_000) })
  const result = await response.json().catch(() => null) as WorkerCommandResult | null
  if (!response.ok || !result) throw new Error(result?.error || `Worker command failed (${response.status})`)
  return result
}
