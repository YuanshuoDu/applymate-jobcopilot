import React from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentComposerActiveTurn } from './AgentComposerActiveTurn'
import type { TurnComposerController } from './agent-turn-commands'

describe('AgentComposerActiveTurn', () => {
  it('shows delivery choices, all command states, and the interrupt affordance', () => {
    const controller: TurnComposerController = {
      sessionId: 'session_1', activeTurn: { id: 'turn_1', status: 'in_progress', revision: 2 }, delivery: 'steer',
      setDelivery: vi.fn(), chatInput: '', setChatInput: vi.fn(), sending: false,
      messages: [
        { clientMessageId: 'sending', text: 'One', delivery: 'steer', status: 'sending' },
        { clientMessageId: 'accepted', text: 'Two', delivery: 'follow_up', status: 'accepted' },
        { clientMessageId: 'consumed', text: 'Three', delivery: 'steer', status: 'consumed' },
        { clientMessageId: 'failed', text: 'Four', delivery: 'steer', status: 'failed' },
      ],
      commandError: null, send: vi.fn(), interrupt: vi.fn(), interrupting: false,
    }
    const html = renderToString(<AgentComposerActiveTurn controller={controller} />)

    expect(html).toContain('Steer current Turn')
    expect(html).toContain('Queue follow-up')
    expect(html).toContain('data-testid="interrupt-turn"')
    expect(html).toContain('Sending')
    expect(html).toContain('Accepted')
    expect(html).toContain('Consumed')
    expect(html).toContain('Failed')
  })
})
