import { describe, expect, it } from 'vitest'

import {
  parseSteeringMarkerEvent,
  parseSteeringMarkerPayload,
  reduceTimelineSteeringMarkers,
  steeringMarkerIdempotencyKey,
  STEERING_MARKER_EVENT_TYPE,
  STEERING_MARKER_SCHEMA_VERSION,
} from './timeline-steering-markers'

const scope = { sessionId: 'session-1' } as const

function payload(inputId = 'input-1', kind: 'observed' | 'applied' = 'observed', overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: STEERING_MARKER_SCHEMA_VERSION, kind, status: kind, sessionId: scope.sessionId,
    turnId: 'turn-1', taskId: 'task-1', stepId: 'step-1', inputId,
    idempotencyKey: steeringMarkerIdempotencyKey(scope.sessionId, 'turn-1', inputId), obligationId: 'obligation-1',
    goalRevision: 1, planRevision: 1, acceptedSequence: '1', ...overrides,
  }
}

function event(sequence: string, inputId = 'input-1', kind: 'observed' | 'applied' = 'observed', overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'agent-harness.v2', id: `event-${sequence}-${inputId}-${kind}`, sessionId: scope.sessionId,
    turnId: 'turn-1', itemId: null, taskId: 'task-1', type: STEERING_MARKER_EVENT_TYPE, actor: 'system', sequence,
    payload: payload(inputId, kind), ...overrides,
  }
}

describe('timeline steering marker reducer', () => {
  it('folds observed, applied, and active counts across a replay', () => {
    const result = reduceTimelineSteeringMarkers([event('1'), event('2', 'input-1', 'applied'), event('3', 'input-2')], scope)

    expect(result).toMatchObject({ valid: true, state: { observedCount: 2, appliedCount: 1, activeCount: 1 } })
    if (result.valid) {
      expect(result.state.active.map(marker => marker.inputId)).toEqual(['input-2'])
      expect(result.state.applied.map(marker => marker.inputId)).toEqual(['input-1'])
    }
  })

  it('requires observed before applied and keeps invalid state out of the projection', () => {
    const result = reduceTimelineSteeringMarkers([event('2', 'input-1', 'applied')], scope)
    expect(result).toEqual({ valid: false, reason: 'orphan_applied' })
  })

  it('is idempotent for an identical event and rejects identity or sequence conflicts', () => {
    const first = event('1')
    const duplicate = reduceTimelineSteeringMarkers([first, first], scope)
    expect(duplicate).toMatchObject({ valid: true, state: { observedCount: 1 } })

    expect(reduceTimelineSteeringMarkers([first, { ...first, payload: payload('input-1', 'observed', { goalRevision: 2 }) }], scope)).toEqual({ valid: false, reason: 'event_conflict' })
    expect(reduceTimelineSteeringMarkers([first, event('2', 'input-1')], scope)).toEqual({ valid: false, reason: 'marker_conflict' })
    expect(reduceTimelineSteeringMarkers([first, event('1', 'input-2')], scope)).toEqual({ valid: false, reason: 'sequence_conflict' })
  })

  it('rejects extra payload keys, foreign scope, actor pollution, and non-null item IDs', () => {
    expect(parseSteeringMarkerPayload({ ...payload(), narrative: 'never render this' })).toBeNull()
    expect(parseSteeringMarkerEvent({ ...event('1'), sessionId: 'session-2' }, scope)).toBeNull()
    expect(parseSteeringMarkerEvent({ ...event('1'), actor: 'orchestrator' }, scope)).toBeNull()
    expect(parseSteeringMarkerEvent({ ...event('1'), itemId: 'item-1' }, scope)).toBeNull()
    expect(parseSteeringMarkerEvent({ ...event('1'), kind: 'delta' }, scope)).toBeNull()
    expect(parseSteeringMarkerEvent({ ...event('1'), shell: 'polluted' }, scope)).toBeNull()
  })

  it('enforces bounded event count and bytes', () => {
    const many = Array.from({ length: 129 }, (_, index) => event(String(index + 1), `input-${index + 1}`))
    expect(reduceTimelineSteeringMarkers(many, scope)).toEqual({ valid: false, reason: 'event_limit' })
    const large = Array.from({ length: 64 }, (_, index) => ({ ...event(String(index + 1), `input-${index + 1}-${'x'.repeat(80)}`), id: `event-${index + 1}` }))
    expect(reduceTimelineSteeringMarkers(large, scope)).toEqual({ valid: false, reason: 'byte_limit' })
  })
})
