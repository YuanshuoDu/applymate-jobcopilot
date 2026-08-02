import React from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentNewChatWelcome } from './AgentNewChatWelcome'

describe('AgentNewChatWelcome', () => {
  it('renders an actionable new-chat workspace instead of an empty panel', () => {
    const html = renderToString(<AgentNewChatWelcome onSelectPrompt={vi.fn()} />)

    expect(html).toContain('What would you like to do with ApplyMate?')
    expect(html).toContain('Find matching jobs')
    expect(html).toContain('Prepare an application')
    expect(html).toContain('Review before applying')
    expect(html).toContain('Fix a job-search issue')
  })
})
