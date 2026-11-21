import { describe, expect, it } from 'vitest'
import {
  agentSessionUrl,
  hasAuthoritativeAgentTurnState,
  parseActiveTurn,
  parseAgentTurnsResponse,
  readAgentSessionId,
  resolveAgentTurnStateReadiness,
  selectedSessionControlStatusValue,
} from './agent-session-state'

describe('agent session URL and active Turn DTO', () => {
  it('uses sessionId as the URL source and preserves the workspace page query', () => {
    const href = 'https://applymate.test/?page=agent&filter=all#workspace'
    const next = agentSessionUrl('session_1', href)

    expect(readAgentSessionId(next)).toBe('session_1')
    expect(next).toBe('/?page=agent&filter=all&sessionId=session_1#workspace')
    expect(agentSessionUrl(null, next)).toBe('/?page=agent&filter=all#workspace')
  })

  it('rejects malformed active Turn values instead of inventing state', () => {
    expect(parseActiveTurn({ id: 'turn_1', status: 'done', revision: 1 })).toBeNull()
    expect(parseActiveTurn({ id: 'turn_1', status: 'in_progress', revision: -1 })).toBeNull()
  })

  it('parses the server projection as the typed active Turn DTO', () => {
    expect(parseAgentTurnsResponse({
      turns: [{ id: 'turn_1', status: 'in_progress', revision: 3 }],
      projection: {
        activeTurnId: 'turn_1',
        activeTurn: { id: 'turn_1', status: 'in_progress', revision: 3, goal: 'Current objective' },
        queuedInputCount: 2,
      },
    })).toEqual({
      activeTurn: { id: 'turn_1', status: 'in_progress', revision: 3, goal: 'Current objective' },
      queuedInputCount: 2,
    })
  })

  it('accepts only a canonical, owner-selected confirmed/applied scope projection', () => {
    const turn = { id: 'turn_1', status: 'in_progress', revision: 3 }
    const locationScope = { confirmed: { locations: ['dublin'], status: 'pending' }, appliedLocations: ['berlin'] }
    expect(parseAgentTurnsResponse({ turns: [turn], projection: {
      activeTurnId: 'turn_1', activeTurn: { ...turn, locationScope },
    } }).activeTurn).toEqual({ ...turn, locationScope })
    expect(parseAgentTurnsResponse({ projection: {
      activeTurnId: 'turn_1', activeTurn: { ...turn, locationScope: { confirmed: { locations: ['Dublin'], status: 'adopted' }, appliedLocations: ['Dublin'] } },
    } }).activeTurn).toEqual(turn)
    expect(parseAgentTurnsResponse({ turns: [{ ...turn, id: 'turn_2' }], projection: {
      activeTurnId: 'turn_2', activeTurn: { ...turn, id: 'turn_1', locationScope },
    } }).activeTurn).toEqual({ id: 'turn_2', status: 'in_progress', revision: 3 })
  })

  it('grants the location capability only from a literal true on the matching projection', () => {
    const active = { id: 'turn_1', status: 'in_progress', revision: 3 }
    expect(parseAgentTurnsResponse({
      turns: [{ ...active, canSteerLocation: true }],
      projection: { activeTurnId: 'turn_1', activeTurn: { ...active, canSteerLocation: true } },
    }).activeTurn).toEqual({ ...active, canSteerLocation: true })
    for (const value of [false, 1, 'true', null]) {
      expect(parseAgentTurnsResponse({
        projection: { activeTurnId: 'turn_1', activeTurn: { ...active, canSteerLocation: value } },
      }).activeTurn).toEqual(active)
    }
    for (const status of ['queued', 'waiting_for_approval', 'waiting_for_user']) {
      expect(parseAgentTurnsResponse({
        projection: { activeTurnId: 'turn_1', activeTurn: { ...active, status, canSteerLocation: true } },
      }).activeTurn).toEqual({ ...active, status })
    }
    expect(parseAgentTurnsResponse({
      turns: [{ ...active, canSteerLocation: true }],
      projection: { activeTurnId: 'turn_1' },
    }).activeTurn).toEqual(active)
    expect(parseAgentTurnsResponse({
      projection: { activeTurnId: 'turn_2', activeTurn: { ...active, canSteerLocation: true } },
    }).activeTurn).toBeNull()
  })

  it('treats only a complete active-Turn projection as authoritative', () => {
    expect(hasAuthoritativeAgentTurnState({ turns: [], projection: { activeTurnId: null, activeTurn: null } })).toBe(true)
    expect(hasAuthoritativeAgentTurnState({ turns: [], projection: { activeTurnId: 'turn_1', activeTurn: { id: 'turn_1', status: 'in_progress', revision: 1 } } })).toBe(true)
    expect(hasAuthoritativeAgentTurnState({ turns: [{ id: 'turn_1', status: 'in_progress', revision: 1 }], projection: { activeTurnId: null, activeTurn: null } })).toBe(false)
    expect(hasAuthoritativeAgentTurnState({ turns: [], projection: { activeTurnId: null } })).toBe(false)
    expect(hasAuthoritativeAgentTurnState({ turns: [], projection: {} })).toBe(false)
    expect(hasAuthoritativeAgentTurnState({})).toBe(false)
  })

  it('keeps loading, ready, and error scoped to the selected Session', () => {
    expect(resolveAgentTurnStateReadiness('session-b', 'session-a', false, null)).toBe('loading')
    expect(resolveAgentTurnStateReadiness('session-b', 'session-b', true, null)).toBe('loading')
    expect(resolveAgentTurnStateReadiness('session-b', 'session-b', false, 'request failed')).toBe('error')
    expect(resolveAgentTurnStateReadiness('session-b', 'session-b', false, null)).toBe('ready')
  })

  it('never reuses another Session control status during selection changes', () => {
    expect(selectedSessionControlStatusValue('session-b', { id: 'session-a', status: 'running' })).toBeNull()
    expect(selectedSessionControlStatusValue('session-b', { id: 'session-b', status: 'paused' })).toBe('paused')
    expect(selectedSessionControlStatusValue('session-b', { id: 'session-b', status: 'unknown' })).toBe('unknown')
    expect(selectedSessionControlStatusValue('session-b', undefined)).toBeNull()
  })

  it('keeps active controls for older projections without a goal', () => {
    expect(parseAgentTurnsResponse({
      projection: { activeTurnId: 'turn_1', activeTurn: { id: 'turn_1', status: 'in_progress', revision: 4 } },
    })).toEqual({ activeTurn: { id: 'turn_1', status: 'in_progress', revision: 4 }, queuedInputCount: 0 })
    expect(parseActiveTurn({ id: 'turn_1', status: 'in_progress', revision: 4, goal: { private: 'not text' } }))
      .toEqual({ id: 'turn_1', status: 'in_progress', revision: 4 })
  })

  it('keeps active controls but never promotes a listed Turn goal without a projected goal', () => {
    for (const goal of ['Canonical objective', 'Process agent task']) {
      expect(parseAgentTurnsResponse({
        turns: [{ id: 'turn_1', status: 'in_progress', revision: 4, goal }],
        projection: { activeTurnId: 'turn_1', activeTurn: { id: 'turn_1', status: 'in_progress', revision: 4 } },
      }).activeTurn).toEqual({ id: 'turn_1', status: 'in_progress', revision: 4 })
    }
  })

  it('clears the objective when the active projection is absent or refers to a different Turn', () => {
    const oldTurn = { id: 'turn_old', status: 'in_progress', revision: 4, goal: 'Old objective' }
    expect(parseAgentTurnsResponse({ turns: [oldTurn], projection: { activeTurnId: null, activeTurn: null } }).activeTurn).toBeNull()
    expect(parseAgentTurnsResponse({ turns: [oldTurn], projection: { activeTurnId: 'turn_old', activeTurn: null } }).activeTurn).toBeNull()
    expect(parseAgentTurnsResponse({ turns: [oldTurn], projection: { activeTurnId: 'turn_old' } }).activeTurn)
      .toEqual({ id: 'turn_old', status: 'in_progress', revision: 4 })
    expect(parseAgentTurnsResponse({
      turns: [oldTurn],
      projection: { activeTurnId: 'turn_new', activeTurn: oldTurn },
    }).activeTurn).toBeNull()
    expect(parseAgentTurnsResponse({
      projection: { activeTurn: oldTurn },
    }).activeTurn).toBeNull()
  })
})
