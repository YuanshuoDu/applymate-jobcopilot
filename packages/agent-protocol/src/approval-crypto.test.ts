import { describe, expect, it } from 'vitest'

import { createApprovalNonce, hashApprovalNonce, hashApprovalScope } from './approval-crypto.js'

const scope = {
  userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', jobId: 'job-1', toolCallId: 'call-1',
  action: 'submit_application' as const,
  resourceHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  materialHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  answersHash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  revision: 4,
  nonceHash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  expiresAt: '2026-08-31T01:00:00.000Z',
}

describe('approval cryptography', () => {
  it('creates a 32-byte hex nonce and a stable nonce hash', async () => {
    const nonce = createApprovalNonce()
    expect(nonce).toMatch(/^[a-f0-9]{64}$/)
    expect(await hashApprovalNonce(nonce)).toMatch(/^[a-f0-9]{64}$/)
    expect(await hashApprovalNonce(nonce)).toBe(await hashApprovalNonce(nonce))
  })

  it('changes the scope hash when any authorization input changes', async () => {
    const original = await hashApprovalScope(scope)
    expect(original).toMatch(/^[a-f0-9]{64}$/)
    expect(await hashApprovalScope({ ...scope, jobId: 'job-2' })).not.toBe(original)
    expect(await hashApprovalScope({ ...scope, materialHash: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' })).not.toBe(original)
    expect(await hashApprovalScope({ ...scope, answersHash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' })).not.toBe(original)
    expect(await hashApprovalScope({ ...scope, revision: 5 })).not.toBe(original)
    expect(await hashApprovalScope({ ...scope, expiresAt: '2026-08-31T02:00:00.000Z' })).not.toBe(original)
  })
})
