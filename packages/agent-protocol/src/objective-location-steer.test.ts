import { describe, expect, it } from 'vitest'
import {
  formatObjectiveLocationSteerMessage,
  OBJECTIVE_LOCATION_STEER_ACCEPTED_EVENT_TYPE,
  OBJECTIVE_LOCATION_STEER_SCHEMA_VERSION,
  ObjectiveLocationSteerReceiptSchema,
  ObjectiveLocationSteerRequestSchema,
  validate,
} from './index.js'

const request = {
  schemaVersion: OBJECTIVE_LOCATION_STEER_SCHEMA_VERSION,
  clientMessageId: 'client-message-1',
  expectedTurnId: 'turn-1',
  expectedRevision: 0,
  locations: [' Dublin ', 'Berlin'],
}

const receipt = {
  schemaVersion: OBJECTIVE_LOCATION_STEER_SCHEMA_VERSION,
  acceptedInputSequence: 1,
  locations: request.locations,
}

describe('objective location steer protocol', () => {
  it('formats distinct normalized location arrays without comma ambiguity', () => {
    const combined = formatObjectiveLocationSteerMessage(['a, b'])
    const separate = formatObjectiveLocationSteerMessage(['a', 'b'])
    expect(combined).toBe('The user explicitly confirmed these allowed job locations: ["a, b"].')
    expect(separate).toBe('The user explicitly confirmed these allowed job locations: ["a","b"].')
    expect(combined).not.toBe(separate)
  })

  it('exports an opt-in request and separate server-authored receipt shape', () => {
    expect(OBJECTIVE_LOCATION_STEER_ACCEPTED_EVENT_TYPE).toBe('agent.objective.locations_accepted')
    expect(validate(ObjectiveLocationSteerRequestSchema, request)).toBe(true)
    expect(validate(ObjectiveLocationSteerReceiptSchema, receipt)).toBe(true)
  })

  it('rejects unexpected fields, identifiers, and revisions outside the bounded request shape', () => {
    expect(validate(ObjectiveLocationSteerRequestSchema, { ...request, sessionId: 'session-1' })).toBe(false)
    expect(validate(ObjectiveLocationSteerRequestSchema, { ...request, debug: true })).toBe(false)
    expect(validate(ObjectiveLocationSteerRequestSchema, { ...request, clientMessageId: '' })).toBe(false)
    expect(validate(ObjectiveLocationSteerRequestSchema, { ...request, expectedTurnId: '' })).toBe(false)
    expect(validate(ObjectiveLocationSteerRequestSchema, { ...request, expectedRevision: -1 })).toBe(false)
    expect(validate(ObjectiveLocationSteerRequestSchema, { ...request, expectedRevision: 2_147_483_648 })).toBe(false)
    expect(validate(ObjectiveLocationSteerRequestSchema, { ...request, expectedRevision: 1.5 })).toBe(false)
    expect(validate(ObjectiveLocationSteerRequestSchema, { ...request, schemaVersion: 'agent-harness.v2' })).toBe(false)
  })

  it('bounds raw location text and array size while allowing pre-normalized values', () => {
    expect(validate(ObjectiveLocationSteerRequestSchema, { ...request, locations: ['  Dublin  '] })).toBe(true)
    expect(validate(ObjectiveLocationSteerRequestSchema, { ...request, locations: ['\t\n'] })).toBe(false)
    expect(validate(ObjectiveLocationSteerRequestSchema, { ...request, locations: [''] })).toBe(false)
    expect(validate(ObjectiveLocationSteerRequestSchema, { ...request, locations: ['x'.repeat(128)] })).toBe(true)
    expect(validate(ObjectiveLocationSteerRequestSchema, { ...request, locations: ['x'.repeat(129)] })).toBe(false)
    expect(validate(ObjectiveLocationSteerRequestSchema, { ...request, locations: [] })).toBe(false)
    expect(validate(ObjectiveLocationSteerRequestSchema, { ...request, locations: Array(9).fill('Dublin') })).toBe(false)
  })

  it('requires a positive safe accepted-input sequence and exact receipt fields', () => {
    expect(validate(ObjectiveLocationSteerReceiptSchema, { ...receipt, acceptedInputSequence: 0 })).toBe(false)
    expect(validate(ObjectiveLocationSteerReceiptSchema, { ...receipt, acceptedInputSequence: 1.5 })).toBe(false)
    expect(validate(ObjectiveLocationSteerReceiptSchema, { ...receipt, acceptedInputSequence: Number.MAX_SAFE_INTEGER + 1 })).toBe(false)
    expect(validate(ObjectiveLocationSteerReceiptSchema, { ...receipt, acceptedInputSequence: 1, acceptedAt: 'now' })).toBe(false)
    expect(validate(ObjectiveLocationSteerReceiptSchema, { ...receipt, locations: [] })).toBe(false)
  })
})
