import { describe, expect, it } from 'vitest'

import { isAgentPreviewFixtureEnabled, isAgentPreviewRequestAllowed } from './agent-preview-access'

const productionFixture = { NODE_ENV: 'production', AGENT_PREVIEW_FIXTURE: '1' }
const loopbackRequest = { hostname: '127.0.0.1', hostHeader: '127.0.0.1:3000', forwardedHost: 'localhost:3000' }

describe('agent preview fixture access', () => {
  it('requires an explicit production flag while preserving development access', () => {
    expect(isAgentPreviewFixtureEnabled({ NODE_ENV: 'production' })).toBe(false)
    expect(isAgentPreviewFixtureEnabled(productionFixture)).toBe(true)
    expect(isAgentPreviewFixtureEnabled({ NODE_ENV: 'development' })).toBe(true)
  })

  it('denies a production fixture when either Vercel deployment marker is present', () => {
    const vercelEnvironments = [
      { ...productionFixture, VERCEL: '1' },
      { ...productionFixture, VERCEL_ENV: 'preview' },
      { ...productionFixture, VERCEL_ENV: 'production' },
    ]
    for (const environment of vercelEnvironments) {
      expect(isAgentPreviewFixtureEnabled(environment)).toBe(false)
      expect(isAgentPreviewRequestAllowed({ environment, ...loopbackRequest })).toBe(false)
    }
  })

  it('allows only loopback host identities in the flagged production fixture', () => {
    expect(isAgentPreviewRequestAllowed({
      environment: productionFixture, ...loopbackRequest,
    })).toBe(true)
    expect(isAgentPreviewRequestAllowed({ environment: { NODE_ENV: 'production' }, hostname: '127.0.0.1' })).toBe(false)
    expect(isAgentPreviewRequestAllowed({
      environment: productionFixture, hostname: 'applymate.site', hostHeader: 'applymate.site', forwardedHost: 'localhost',
    })).toBe(false)
    expect(isAgentPreviewRequestAllowed({
      environment: productionFixture, hostname: '127.0.0.1', hostHeader: '127.0.0.1', forwardedHost: 'applymate.site',
    })).toBe(false)
  })

  it('preserves loopback access in development and denies non-loopback hosts', () => {
    expect(isAgentPreviewRequestAllowed({ environment: { NODE_ENV: 'development' }, ...loopbackRequest })).toBe(true)
    expect(isAgentPreviewRequestAllowed({ environment: { NODE_ENV: 'development' }, hostname: 'applymate.site' })).toBe(false)
  })
})
