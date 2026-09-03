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
        activeTurn: { id: 'turn_1', status: 'in_progress', revision: 3 },
        queuedInputCount: 2,
      },
    })).toEqual({
      activeTurn: { id: 'turn_1', status: 'in_progress', revision: 3 },
      queuedInputCount: 2,
    })
  })
})
