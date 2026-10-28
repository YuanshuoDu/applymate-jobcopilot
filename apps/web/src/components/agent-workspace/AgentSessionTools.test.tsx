import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentSessionTools } from './AgentSessionTools'

const mocks = vi.hoisted(() => ({ team: vi.fn(), automation: vi.fn() }))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('./AgentTeamList', () => ({ AgentTeamList: (props: unknown) => { mocks.team(props); return <div>Team controls</div> } }))
vi.mock('./AutomationList', () => ({ AutomationList: (props: unknown) => { mocks.automation(props); return <input aria-label="Automation draft" defaultValue="Daily search" /> } }))
vi.mock('./HealthStrip', () => ({ HealthStrip: () => <div>Health details</div> }))

describe('AgentSessionTools disclosures', () => {
  it('keeps automation controls available without exposing internal team or health panels', () => {
    const onCreate = vi.fn()
    const onSessionStarted = vi.fn()
    const html = renderToStaticMarkup(<AgentSessionTools onCreate={onCreate} onSessionStarted={onSessionStarted} />)
    expect(html.match(/<details /g)).toHaveLength(1)
    expect(html).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/)
    expect(html).toMatch(/<summary[^>]*>agent.automations<\/summary>/)
    expect(html).toContain('value="Daily search"')
    expect(html).not.toContain('Team controls')
    expect(html).not.toContain('Health details')
    expect(mocks.team).not.toHaveBeenCalled()
    expect(mocks.automation).toHaveBeenCalledWith({ onCreate, onSessionStarted })
  })
})
