import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyWorkerCommand } from './control-auth.js'

describe('worker control command verification', () => {
  const secret = 'test-secret'
  const body = JSON.stringify({ requestId: 'request', timestamp: 1_000, nonce: 'nonce', actorId: 'admin', action: 'queue_summary', reason: 'View queue health summary', params: {} })
  const signature = createHmac('sha256', secret).update(body).digest('hex')
  it('accepts a current signed allow-listed command', () => expect(verifyWorkerCommand(body, signature, secret, 1_001)).toMatchObject({ action: 'queue_summary' }))
  it('rejects tampering and stale commands before queue access', () => {
    expect(verifyWorkerCommand(body, 'invalid', secret, 1_001)).toBeNull()
    expect(verifyWorkerCommand(body, signature, secret, 400_001)).toBeNull()
  })
})
