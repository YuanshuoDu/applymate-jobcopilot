import { describe, expect, it } from 'vitest'
import {
  agentSessionUrl,
  parseActiveTurn,
  parseAgentTurnsResponse,
  readAgentSessionId,
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

  it('keeps active controls for older projections without a goal', () => {
    expect(parseAgentTurnsResponse({
      projection: { activeTurnId: 'turn_1', activeTurn: { id: 'turn_1', status: 'in_progress', revision: 4 } },
    })).toEqual({ activeTurn: { id: 'turn_1', status: 'in_progress', revision: 4 }, queuedInputCount: 0 })
    expect(parseActiveTurn({ id: 'turn_1', status: 'in_progress', revision: 4, goal: { private: 'not text' } }))
      .toEqual({ id: 'turn_1', status: 'in_progress', revision: 4 })
  })

  it('uses a matching listed Turn only when the active projection lacks its goal', () => {
    expect(parseAgentTurnsResponse({
      turns: [{ id: 'turn_1', status: 'in_progress', revision: 4, goal: 'Canonical objective' }],
      projection: { activeTurnId: 'turn_1', activeTurn: { id: 'turn_1', status: 'in_progress', revision: 4 } },
    }).activeTurn).toEqual({ id: 'turn_1', status: 'in_progress', revision: 4, goal: 'Canonical objective' })
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
