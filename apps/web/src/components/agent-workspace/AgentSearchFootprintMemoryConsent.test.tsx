import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentSearchFootprintMemoryConsent } from './AgentSearchFootprintMemoryConsent'

describe('AgentSearchFootprintMemoryConsent', () => {
  it('explains the narrow advisory scope and keeps the control closed while loading', () => {
    const html = renderToStaticMarkup(<AgentSearchFootprintMemoryConsent />)
    expect(html).toContain('bounded role, location, and source search criteria')
    expect(html).toContain('Each objective still requires a fresh search')
    expect(html).toContain('separate from Task History memory')
    expect(html).toContain('grants no action, approval, or submission authority')
    expect(html).toContain('aria-label="Allow future sessions to refer to bounded search criteria"')
    expect(html).toContain('>Loading…</label>')
    expect(html).not.toContain('checked=""')
    expect(html).toContain('disabled=""')
  })
})
