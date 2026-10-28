import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentWorkspacePanels } from './AgentWorkspacePanels'

describe('Agent workspace progressive disclosure', () => {
  it('gives conversation the default space while retaining mounted detail content', () => {
    const html = renderToStaticMarkup(<AgentWorkspacePanels sessionId="session-a" needsAttention={false}
      toolbar={<button>Find jobs</button>} details={<textarea defaultValue="Preserved draft" />}>
      <main>Conversation</main>
    </AgentWorkspacePanels>)
    expect(html).toContain('aria-expanded="false"')
    expect(html).toMatch(/id="agent-workspace-details"[^>]*hidden=""/)
    expect(html).toContain('Preserved draft')
    expect(html).toContain('Tasks &amp; results')
    expect(html).toContain('<main>Conversation</main>')
  })

  it('keeps required action discoverable even while details are closed', () => {
    const html = renderToStaticMarkup(<AgentWorkspacePanels sessionId="session-a" needsAttention
      toolbar={null} details={<button>Approve</button>}>Conversation</AgentWorkspacePanels>)
    expect(html.indexOf('Needs attention')).toBeLessThan(html.indexOf('id="agent-workspace-details"'))
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-controls="agent-workspace-details"')
  })

  it('has no irrelevant task entry for a new conversation', () => {
    const html = renderToStaticMarkup(<AgentWorkspacePanels sessionId={null} needsAttention={false}
      toolbar={<button>Find jobs</button>} details={null}>Welcome</AgentWorkspacePanels>)
    expect(html).not.toContain('aria-controls="agent-workspace-details"')
    expect(html).toContain('Find jobs')
    expect(html).toContain('Welcome')
  })
})
