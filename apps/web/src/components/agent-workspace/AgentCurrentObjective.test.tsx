import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentCurrentObjective } from './AgentCurrentObjective'

describe('AgentCurrentObjective', () => {
  it('labels and safely renders the canonical goal with compact wrapping', () => {
    const html = renderToStaticMarkup(<AgentCurrentObjective goal={'Find roles <script>alert("x")</script>'} />)

    expect(html).toContain('aria-label="Current objective"')
    expect(html).toContain('Current objective')
    expect(html).toContain('Find roles &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
    expect(html).toContain('max-height:72px')
    expect(html).toContain('overflow-wrap:anywhere')
    expect(html).toContain('white-space:pre-wrap')
  })

  it('shows nothing when the active Turn goal is unavailable', () => {
    expect(renderToStaticMarkup(<AgentCurrentObjective />)).toBe('')
    expect(renderToStaticMarkup(<AgentCurrentObjective goal="   " />)).toBe('')
    expect(renderToStaticMarkup(<AgentCurrentObjective goal={null} />)).toBe('')
  })
})
