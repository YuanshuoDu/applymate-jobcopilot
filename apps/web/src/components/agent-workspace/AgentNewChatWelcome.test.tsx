import React from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentNewChatWelcome } from './AgentNewChatWelcome'

describe('AgentNewChatWelcome', () => {
  it('renders an actionable new-chat workspace instead of an empty panel', () => {
    const html = renderToString(<AgentNewChatWelcome />)

    expect(html).toContain('ApplyMate AI')
    expect(html).toContain('What can I help you with?')
    expect(html).toContain('Start a new ApplyMate conversation below.')
  })
})
