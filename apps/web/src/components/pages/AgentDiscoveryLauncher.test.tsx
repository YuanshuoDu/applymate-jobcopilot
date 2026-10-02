import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { agentDiscoveryAnnouncement, AgentDiscoveryLauncher, AgentDiscoveryStatus } from './AgentDiscoveryLauncher'

describe('AgentDiscoveryLauncher', () => {
  it('offers the discovery action without exposing a legacy Stop control', () => {
    const props = {
      onTaskGraphStarted: vi.fn(),
      t: (key: string) => key,
    }

    const html = renderToStaticMarkup(<AgentDiscoveryLauncher {...props} />)

    expect(html).toContain('agent.runNow')
    expect(html).not.toContain('common.stop')
  })

  it('announces server-disabled discovery through an assertive alert', () => {
    const status = agentDiscoveryAnnouncement({ mode: 'unavailable', reason: 'feature_disabled' })
    const html = renderToStaticMarkup(<AgentDiscoveryStatus status={status} />)

    expect(status.text).toBe('Agent discovery is currently unavailable.')
    expect(html).toContain('role="alert"')
    expect(html).toContain('aria-live="assertive"')
    expect(html).toContain('Agent discovery is currently unavailable.')
  })

  it('announces the plan entitlement requirement to the user', () => {
    const status = agentDiscoveryAnnouncement({ mode: 'unavailable', reason: 'not_entitled' })

    expect(status).toEqual({ kind: 'unavailable', text: 'Job discovery is not included in your current plan.' })
  })
})
