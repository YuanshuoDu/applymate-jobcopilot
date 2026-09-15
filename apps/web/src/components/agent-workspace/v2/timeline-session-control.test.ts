import { describe, expect, it } from 'vitest'

import {
  createTimelineSessionControlState,
  parseTimelineSessionControl,
  reduceTimelineSessionControl,
} from './timeline-session-control'

function control(type: 'session.paused' | 'session.resumed', sequence = '5') {
  const paused = type === 'session.paused'
  return {
    schemaVersion: 'agent-harness.v2', id: `control-${sequence}`, sessionId: 'session-1', turnId: null,
    itemId: null, taskId: null, type, actor: 'system', correlationId: 'session-1', causationId: null,
    idempotencyKey: `agent-session-control:client-${sequence}`, sequence,
    payload: {
      sessionId: 'session-1', operation: paused ? 'pause' : 'resume',
      previousGate: paused ? 'open' : 'user_paused', nextGate: paused ? 'user_paused' : 'open',
      controlRevision: paused ? 1 : 2, pausedAt: paused ? '2026-09-15T00:00:00.000Z' : null,
    },
  }
}

describe('timeline session control parser', () => {
  it('accepts only the bounded pause/resume envelope', () => {
    const parsed = parseTimelineSessionControl(control('session.paused'), 'session-1')
    expect(parsed).toMatchObject({ type: 'session.paused', turnId: null, itemId: null, taskId: null, actor: 'system' })
    expect(parsed?.payload).toEqual({
      sessionId: 'session-1', operation: 'pause', previousGate: 'open', nextGate: 'user_paused',
      controlRevision: 1, pausedAt: '2026-09-15T00:00:00.000Z',
    })
  })

  it('rejects foreign, sensitive, extra, and ordinary null-turn events', () => {
    expect(parseTimelineSessionControl({ ...control('session.paused'), sessionId: 'session-2' }, 'session-1')).toBeNull()
    expect(parseTimelineSessionControl({ ...control('session.paused'), payload: { ...control('session.paused').payload, token: 'secret' } }, 'session-1')).toBeNull()
    expect(parseTimelineSessionControl({ ...control('session.paused'), turnId: 'turn-1' }, 'session-1')).toBeNull()
    expect(parseTimelineSessionControl({ ...control('session.paused'), type: 'item.completed' }, 'session-1')).toBeNull()
  })

  it('applies newer revisions and keeps older revisions from rolling state back', () => {
    const paused = parseTimelineSessionControl(control('session.paused', '5'), 'session-1')
    const resumed = parseTimelineSessionControl(control('session.resumed', '6'), 'session-1')
    expect(paused).not.toBeNull()
    expect(resumed).not.toBeNull()
    const state = reduceTimelineSessionControl(createTimelineSessionControlState(), paused!)
    expect(reduceTimelineSessionControl(state, resumed!)).toEqual({ controlGate: 'open', controlRevision: 2, pausedAt: null })
    expect(reduceTimelineSessionControl(state, paused!)).toBe(state)
  })
})
