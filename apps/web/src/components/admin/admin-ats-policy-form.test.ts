import { describe, expect, it } from 'vitest'
import { toAtsPolicyPayload } from './admin-ats-policy-form'

describe('ATS policy editor payload', () => {
  it('includes every persisted operational control', () => {
    expect(toAtsPolicyPayload({
      state: 'enabled',
      enabled: true,
      rolloutPercent: 100,
      globalRpsLimit: 5,
      perTenantRpsLimit: 1,
      maxRetries: 3,
      backoffBaseMs: 1000,
      allowAutoApply: true,
      version: 4,
      lastAcknowledgedVersion: 4,
    })).toEqual({
      rolloutPercent: 100,
      globalRpsLimit: 5,
      perTenantRpsLimit: 1,
      maxRetries: 3,
      backoffBaseMs: 1000,
      allowAutoApply: true,
      version: 4,
    })
  })
})
