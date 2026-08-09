import { createHmac, timingSafeEqual } from 'node:crypto'

export type ControlAction = 'queue_summary' | 'failed_queue_jobs' | 'retry_queue_job' | 'pause_queue' | 'resume_queue' | 'apply_ats_policy'
export type WorkerControlCommand = { requestId: string; timestamp: number; nonce: string; actorId: string; action: ControlAction; reason: string; params: Record<string, string | number | boolean> }

function validCommand(value: unknown): value is WorkerControlCommand {
  if (!value || typeof value !== 'object') return false
  const command = value as Record<string, unknown>
  return typeof command.requestId === 'string' && typeof command.timestamp === 'number' && typeof command.nonce === 'string' && typeof command.actorId === 'string' && typeof command.reason === 'string' && command.reason.length >= 10 && command.reason.length <= 500 && ['queue_summary', 'failed_queue_jobs', 'retry_queue_job', 'pause_queue', 'resume_queue', 'apply_ats_policy'].includes(String(command.action)) && !!command.params && typeof command.params === 'object'
}

export function verifyWorkerCommand(body: string, supplied: string | undefined, secret: string, now = Date.now()) {
  if (!supplied) return null
  const expected = createHmac('sha256', secret).update(body).digest('hex')
  if (supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return null
  try {
    const command: unknown = JSON.parse(body)
    return validCommand(command) && Math.abs(now - command.timestamp) <= 300_000 ? command : null
  } catch { return null }
}
