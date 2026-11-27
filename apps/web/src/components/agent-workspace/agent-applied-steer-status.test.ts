import { describe, expect, it } from 'vitest'
import type { ComposerMessage } from './agent-turn-commands'
import type { TimelineSteeringMarkerPayload } from './v2/timeline-steering-markers'
import { appliedPlanRevisionForMessage, appliedSteerStatusLabel, selectedSessionAppliedSteeringMarkers } from './agent-applied-steer-status'

const message: ComposerMessage = {
  clientMessageId: 'client-1', text: 'Add a Berlin preference', delivery: 'steer', status: 'accepted',
  inputId: 'input-1', turnId: 'turn-1',
}

function marker(overrides: Partial<TimelineSteeringMarkerPayload> = {}): TimelineSteeringMarkerPayload {
  return {
    schemaVersion: 'agent-harness.steering-marker.v1', kind: 'applied', status: 'applied',
    sessionId: 'session-1', turnId: 'turn-1', taskId: 'root-1', stepId: 'step-1', inputId: 'input-1',
    idempotencyKey: 'steering-marker:session-1:turn-1:input-1', obligationId: 'steering:input-1',
    goalRevision: 2, planRevision: 7, acceptedSequence: '12', ...overrides,
  }
}

describe('applied steer status', () => {
  it('associates only the exact session, Turn, and server input with a concrete applied revision', () => {
    expect(appliedPlanRevisionForMessage(message, 'session-1', [marker()])).toBe(7)
    expect(appliedPlanRevisionForMessage({ ...message, turnId: undefined }, 'session-1', [marker()])).toBeNull()
    expect(appliedPlanRevisionForMessage({ ...message, inputId: undefined }, 'session-1', [marker()])).toBeNull()
  })

  it('does not claim application for consumed-only, observed, follow-up, foreign, or revisionless input', () => {
    expect(appliedPlanRevisionForMessage({ ...message, status: 'consumed' }, 'session-1', undefined)).toBeNull()
    expect(appliedPlanRevisionForMessage(message, 'session-1', [marker({ kind: 'observed', status: 'observed' })])).toBeNull()
    expect(appliedPlanRevisionForMessage({ ...message, delivery: 'follow_up' }, 'session-1', [marker()])).toBeNull()
    expect(appliedPlanRevisionForMessage(message, 'session-2', [marker()])).toBeNull()
    expect(appliedPlanRevisionForMessage(message, 'session-1', [marker({ planRevision: null })])).toBeNull()
    expect(appliedPlanRevisionForMessage(message, 'session-1', [marker({ turnId: 'turn-2' })])).toBeNull()
    expect(appliedPlanRevisionForMessage(message, 'session-1', [marker({ inputId: 'input-2' })])).toBeNull()
  })

  it('fails closed for duplicate matching projection entries and localizes the fixed label', () => {
    expect(appliedPlanRevisionForMessage(message, 'session-1', [marker(), marker()])).toBeNull()
    expect(appliedSteerStatusLabel(7, 'en')).toBe('Applied to plan · revision 7')
    expect(appliedSteerStatusLabel(7, 'de')).toBe('Auf den Plan angewendet · Revision 7')
    expect(appliedSteerStatusLabel(7, 'fr')).toBe('Appliqué au plan · révision 7')
    expect(appliedSteerStatusLabel(7, 'es')).toBe('Aplicado al plan · revisión 7')
    expect(appliedSteerStatusLabel(7, 'nl')).toBe('Toegepast op het plan · revisie 7')
    expect(appliedSteerStatusLabel(7, 'zh')).toBe('已应用到计划 · 版本 7')
    expect(appliedSteerStatusLabel(0, 'en')).toBeNull()
  })

  it('withholds applied projection during restore and whenever selected, composer, or timeline identity differs', () => {
    const applied = [marker()]
    const matching = { selectedSessionId: 'session-1', composerSessionId: 'session-1', timelineSessionId: 'session-1', restoring: false, applied }
    expect(selectedSessionAppliedSteeringMarkers(matching)).toBe(applied)
    expect(selectedSessionAppliedSteeringMarkers({ ...matching, composerSessionId: 'session-2' })).toBeUndefined()
    expect(selectedSessionAppliedSteeringMarkers({ ...matching, timelineSessionId: 'session-2' })).toBeUndefined()
    expect(selectedSessionAppliedSteeringMarkers({ ...matching, selectedSessionId: null })).toBeUndefined()
    expect(selectedSessionAppliedSteeringMarkers({ ...matching, restoring: true })).toBeUndefined()
  })
})
