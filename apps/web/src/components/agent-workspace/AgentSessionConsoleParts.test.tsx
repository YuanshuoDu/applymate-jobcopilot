import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { EmptyText, Metric } from './AgentSessionConsoleParts'

describe('AgentSessionConsoleParts', () => {
  it('preserves the session metric label, value, and alert color', () => {
    const html = renderToStaticMarkup(<Metric label="Approvals" value="2" alert />)

    expect(html).toContain('Approvals')
    expect(html).toContain('>2</div>')
    expect(html).toContain('color:#d97706')
  })

  it('preserves empty and error text content, title, and tone', () => {
    const muted = renderToStaticMarkup(<EmptyText>No sessions</EmptyText>)
    const error = renderToStaticMarkup(<EmptyText tone="error" title="Request failed">Sessions unavailable</EmptyText>)

    expect(muted).toContain('No sessions')
    expect(muted).toContain('color:var(--text-muted)')
    expect(error).toContain('title="Request failed"')
    expect(error).toContain('Sessions unavailable')
    expect(error).toContain('color:var(--c-danger)')
  })
})
