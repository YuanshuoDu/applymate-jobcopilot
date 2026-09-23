import { describe, expect, it } from 'vitest'

import {
  assertSessionControlIdentity,
  controlFingerprint,
  sessionControlEventKey,
  sessionControlResult,
  type ExistingSessionControl,
} from './session-control-transaction'

describe('session control transaction helpers', () => {
  it('builds stable event keys and command fingerprints', () => {
    expect(sessionControlEventKey('client-1')).toBe('agent-session-control:client-1')
    expect(controlFingerprint('pause', null)).toBe('v1:pause:none')
    expect(controlFingerprint('resume', 4)).toBe('v1:resume:4')
  })

  it('returns the durable control state and rejects idempotency reuse for another operation', () => {
    const command = { sessionId: 'session-1', userId: 'user-1', clientMessageId: 'client-1', source: 'user' as const }
    const existing: ExistingSessionControl = {
      id: 'control-1', operation: 'pause', fingerprint: 'v1:pause:3', previousGate: 'open', nextGate: 'user_paused',
      controlRevision: 4, pausedAt: new Date('2026-09-23T12:00:00.000Z'),
    }

    expect(sessionControlResult(command, 'pause', existing.nextGate, existing.controlRevision, existing.pausedAt, 'duplicate'))
      .toEqual({ sessionId: 'session-1', operation: 'pause', controlGate: 'user_paused', controlRevision: 4, pausedAt: '2026-09-23T12:00:00.000Z', disposition: 'duplicate' })
    expect(() => assertSessionControlIdentity(existing, 'pause', 'v1:pause:3')).not.toThrow()
    expect(() => assertSessionControlIdentity(existing, 'resume', 'v1:resume:3')).toThrow()
  })
})
