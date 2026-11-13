import { describe, expect, it } from 'vitest'
import {
  MAX_ATTEMPT_AGE_MS,
  AgentComposerTaskAttemptStoreError,
  attemptTargetSlot,
  validateTaskAttemptRows,
} from './agent-composer-task-attempt-store-idb'

const accountScope = 'account-test'
const base = {
  accountScope,
  attemptKey: 'attempt-test',
  targetSlot: 'new-session',
  targetKind: 'new-session' as const,
  sessionId: null,
  createKey: 'create-test',
  phase: 'prepared' as const,
  createdAt: 1_000,
  updatedAt: 1_000,
  expiresAt: 1_000 + MAX_ATTEMPT_AGE_MS,
}

function expectInvalid(row: unknown, scope = accountScope) {
  expect(() => validateTaskAttemptRows([row], scope)).toThrow(AgentComposerTaskAttemptStoreError)
}

describe('task attempt IndexedDB metadata validation', () => {
  it('accepts the exact account and target slot record shape', () => {
    expect(validateTaskAttemptRows([base], accountScope)).toEqual([base])
    const selected = { ...base, targetKind: 'selected-session' as const, sessionId: 'session-1', createKey: null,
      targetSlot: attemptTargetSlot('selected-session', 'session-1') }
    expect(validateTaskAttemptRows([selected], accountScope)).toEqual([selected])
  })

  it.each([
    ['another account', { ...base }, 'other-account'],
    ['extra prompt field', { ...base, objective: 'private prompt' }, accountScope],
    ['invalid attempt key', { ...base, attemptKey: 'contains space' }, accountScope],
    ['wrong slot', { ...base, targetSlot: 'session:wrong' }, accountScope],
    ['bad phase', { ...base, phase: 'retry' }, accountScope],
    ['expired shape', { ...base, expiresAt: base.createdAt }, accountScope],
  ])('rejects %s instead of repairing it', (_name, row, scope) => {
    expectInvalid(row, scope)
  })

  it('rejects duplicate slots, duplicate account keys, and account overflow', () => {
    expect(() => validateTaskAttemptRows([base, { ...base, attemptKey: 'other' }], accountScope))
      .toThrow('Stored task recovery metadata is invalid.')
    const otherTarget = { ...base, targetKind: 'selected-session' as const, sessionId: 'session-1', createKey: null,
      targetSlot: attemptTargetSlot('selected-session', 'session-1') }
    expect(() => validateTaskAttemptRows([base, otherTarget], accountScope))
      .toThrow('Stored task recovery metadata is invalid.')
    expect(() => validateTaskAttemptRows(Array.from({ length: 33 }, (_, i) => ({
      ...base, attemptKey: `attempt-${i}`, targetKind: 'selected-session' as const,
      sessionId: `session-${i}`, createKey: null, targetSlot: attemptTargetSlot('selected-session', `session-${i}`),
    })), accountScope)).toThrow('safe account limit')
  })
})
