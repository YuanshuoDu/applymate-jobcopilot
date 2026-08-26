import { describe, expect, it } from 'vitest'
import { EXTERNAL_API_PROVIDERS, isExternalApiProvider } from './external-api-catalog'

describe('external API catalogue', () => {
  it('covers every non-job/model integration with an honest telemetry state', () => {
    expect(EXTERNAL_API_PROVIDERS.map(provider => provider.key)).toEqual(['upstash-redis', 'resend', 'gmail', 'google-oauth', 'github', 'internal-worker', 'neon-postgres', 'azure-key-vault', 'vercel-speed-insights'])
    expect(EXTERNAL_API_PROVIDERS.every(provider => ['events', 'snapshot', 'unavailable'].includes(provider.telemetry))).toBe(true)
  })
  it('rejects unknown providers before event persistence', () => {
    expect(isExternalApiProvider('resend')).toBe(true)
    expect(isExternalApiProvider('unknown-provider')).toBe(false)
  })

  it('marks worker control traffic as event-backed telemetry', () => {
    expect(EXTERNAL_API_PROVIDERS.find(provider => provider.key === 'internal-worker')?.telemetry).toBe('events')
  })

  it('uses the Neon consumption snapshot for infrastructure billing telemetry', () => {
    expect(EXTERNAL_API_PROVIDERS.find(provider => provider.key === 'neon-postgres')).toMatchObject({ billing: 'configurable', telemetry: 'snapshot' })
  })
})
