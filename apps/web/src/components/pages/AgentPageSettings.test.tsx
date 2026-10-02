import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

import { AgentConfigGrid, DEFAULT_CFG } from './AgentPageSettings'

describe('AgentConfigGrid', () => {
  it('renders the existing matching, automation, notification, and AI controls', () => {
    const html = renderToStaticMarkup(<AgentConfigGrid cfg={DEFAULT_CFG} set={vi.fn()} />)

    expect(html).toContain('agent.jobMatchingRules')
    expect(html).toContain('agent.targetRoles')
    expect(html).toContain('agent.applicationLimits')
    expect(html).toContain('agent.finalAuthorization')
    expect(html).toContain('agent.notifications')
    expect(html).toContain('agent.aiModel')
    expect(html).toContain('agent.companiesAvoid')
    expect(html).toContain('agent.priorityCompanies')
    expect(html).toContain('type="password"')
  })
})
