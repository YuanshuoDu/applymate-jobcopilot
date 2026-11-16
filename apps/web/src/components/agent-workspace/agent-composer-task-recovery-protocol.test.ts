import { describe, expect, it } from 'vitest'
import { AgentComposerTaskAttemptStoreError } from './agent-composer-task-attempt-store'
import {
  AgentComposerTaskRecoveryError,
  canAdvanceRecoveryPhase,
  classifyRecoveryError,
  parseRecoveryAccountIndex,
  parseRecoveryAttempt,
  parseRecoveryCreate,
  parseRecoveryScopedBody,
} from './agent-composer-task-recovery-protocol'

const scope = 'a'.repeat(64)
function response(body: unknown, headerScope = scope) {
  return new Response(JSON.stringify(body), { headers: { 'X-Account-Scope': headerScope } })
}

describe('task recovery protocol', () => {
  it('accepts only a bounded authenticated list scope with a matching response header', () => {
    expect(parseRecoveryAccountIndex({ accountScope: scope, attempts: [] }, response({}))).toBe(scope)
    expect(() => parseRecoveryAccountIndex({ accountScope: scope, attempts: [], prompt: 'private' }, response({}))).toThrow()
    expect(() => parseRecoveryAccountIndex({ accountScope: scope, attempts: [] }, response({}, 'b'.repeat(64)))).toThrow()
    expect(() => parseRecoveryAccountIndex({ accountScope: scope, attempts: Array(21).fill({}) }, response({}))).toThrow()
  })

  it('requires response scope and strict bounded states before returning display-safe values', () => {
    const accepted = parseRecoveryScopedBody({ accountScope: scope, state: 'accepted', receipt: {
      sessionId: 'session-1', inputId: 'input-1', turnId: 'turn-1', sequence: '12',
    } }, response({}), scope)
    expect(parseRecoveryAttempt(accepted)).toMatchObject({ state: 'accepted', receipt: { sessionId: 'session-1', turnId: 'turn-1' } })
    expect(parseRecoveryAttempt(parseRecoveryScopedBody({ state: 'unknown' }, response({}), scope))).toEqual({ state: 'unknown' })
    expect(parseRecoveryAttempt(parseRecoveryScopedBody({ accountScope: scope, state: 'unavailable' }, response({}), scope)))
      .toEqual({ state: 'unavailable' })
    expect(() => parseRecoveryScopedBody({ state: 'unknown' }, response({}, 'b'.repeat(64)), scope)).toThrow()
    expect(() => parseRecoveryAttempt(parseRecoveryScopedBody({ state: 'unknown', objective: 'private' }, response({}), scope)))
      .toThrow(AgentComposerTaskRecoveryError)
    expect(() => parseRecoveryAttempt(parseRecoveryScopedBody({ accountScope: scope, state: 'accepted', receipt: {
      sessionId: 'session-1', inputId: 'input-1', turnId: 'turn-1', sequence: '1', content: 'private',
    } }, response({}), scope))).toThrow()
  })

  it('keeps create reconciliation read-only and rejects unbounded or unexpected fields', () => {
    expect(parseRecoveryCreate(parseRecoveryScopedBody({ accountScope: scope, state: 'found', sessionId: 'session-1' }, response({}), scope)))
      .toEqual({ state: 'found', sessionId: 'session-1' })
    expect(parseRecoveryCreate(parseRecoveryScopedBody({ state: 'unknown' }, response({}), scope)))
      .toEqual({ state: 'unknown' })
    expect(() => parseRecoveryCreate(parseRecoveryScopedBody({ state: 'found', sessionId: 'session-1', goal: 'private' }, response({}), scope)))
      .toThrow()
  })

  it('classifies storage failures separately and never allows phase rollback', () => {
    expect(classifyRecoveryError(new AgentComposerTaskAttemptStoreError('task_attempt_storage_unavailable', 'unavailable'))).toBe('storage')
    expect(canAdvanceRecoveryPhase('start-requested', 'accepted')).toBe(true)
    expect(canAdvanceRecoveryPhase('prepared', 'accepted')).toBe(true)
    expect(canAdvanceRecoveryPhase('session-known', 'accepted')).toBe(true)
    expect(canAdvanceRecoveryPhase('abandoned', 'accepted')).toBe(false)
    expect(canAdvanceRecoveryPhase('accepted', 'unknown')).toBe(false)
    expect(canAdvanceRecoveryPhase('prepared', 'unknown')).toBe(false)
  })
})
