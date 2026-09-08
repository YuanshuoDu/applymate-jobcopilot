import { describe, expect, it } from 'vitest'

import { isAgentPreviewFixtureEnabled, isAgentPreviewRequestAllowed } from './agent-preview-access'

const productionFixture = { NODE_ENV: 'production', AGENT_PREVIEW_FIXTURE: '1' }

describe('agent preview fixture access', () => {
  it('requires an explicit production flag while preserving development access', () => {
    expect(isAgentPreviewFixtureEnabled({ NODE_ENV: 'production' })).toBe(false)
    expect(isAgentPreviewFixtureEnabled(productionFixture)).toBe(true)
    expect(isAgentPreviewFixtureEnabled({ NODE_ENV: 'development' })).toBe(true)
  })

  it('allows only loopback host identities in the flagged production fixture', () => {
    expect(isAgentPreviewRequestAllowed({
      environment: productionFixture, hostname: '127.0.0.1', hostHeader: '127.0.0.1:3000', forwardedHost: 'localhost:3000',
    })).toBe(true)
    expect(isAgentPreviewRequestAllowed({ environment: { NODE_ENV: 'production' }, hostname: '127.0.0.1' })).toBe(false)
    expect(isAgentPreviewRequestAllowed({
      environment: productionFixture, hostname: 'applymate.site', hostHeader: 'applymate.site', forwardedHost: 'localhost',
    })).toBe(false)
    expect(isAgentPreviewRequestAllowed({
      environment: productionFixture, hostname: '127.0.0.1', hostHeader: '127.0.0.1', forwardedHost: 'applymate.site',
    })).toBe(false)
  })
})
