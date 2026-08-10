import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyWorkerCommand } from './control-auth.js'

describe('worker control command verification', () => {
  const secret = 'test-secret'
  const body = JSON.stringify({ requestId: 'request', timestamp: 1_000, nonce: 'nonce', actorId: 'admin', action: 'queue_summary', reason: 'View queue health summary', params: {} })
  const signature = createHmac('sha256', secret).update(body).digest('hex')
  it('accepts a current signed allow-listed command', () => expect(verifyWorkerCommand(body, signature, secret, 1_001)).toMatchObject({ action: 'queue_summary' }))
  it('accepts failed-job inspection and retry commands', () => {
    for (const action of ['failed_queue_jobs', 'retry_queue_job']) {
      const nextBody = JSON.stringify({ requestId: 'request', timestamp: 1_000, nonce: action, actorId: 'admin', action, reason: 'Operational triage requires a bounded queue action', params: { queue: 'apply-tasks', ...(action === 'retry_queue_job' ? { jobId: 'job-1' } : {}) } })
      const nextSignature = createHmac('sha256', secret).update(nextBody).digest('hex')
      expect(verifyWorkerCommand(nextBody, nextSignature, secret, 1_001)).toMatchObject({ action })
    }
  })
  it('accepts global worker pause and resume commands', () => {
    for (const action of ['pause_worker', 'resume_worker']) {
      const nextBody = JSON.stringify({ requestId: 'request', timestamp: 1_000, nonce: action, actorId: 'admin', action, reason: 'Operational maintenance requires a worker state change', params: {} })
      const nextSignature = createHmac('sha256', secret).update(nextBody).digest('hex')
      expect(verifyWorkerCommand(nextBody, nextSignature, secret, 1_001)).toMatchObject({ action })
    }
  })
  it('rejects tampering and stale commands before queue access', () => {
    expect(verifyWorkerCommand(body, 'invalid', secret, 1_001)).toBeNull()
    expect(verifyWorkerCommand(body, signature, secret, 400_001)).toBeNull()
  })
})
