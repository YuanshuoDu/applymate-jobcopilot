import { describe, expect, it } from 'vitest'
import { isApplyMateDashboardUrl, isAuthFailure } from '../src/lib/auth-recovery'

describe('extension auth recovery', () => {
  it('accepts only the production candidate dashboard origin', () => {
    expect(isApplyMateDashboardUrl('https://applymate.site/?page=jobs')).toBe(true)
    expect(isApplyMateDashboardUrl('https://admin.applymate.site/admin')).toBe(false)
    expect(isApplyMateDashboardUrl('https://applymate.site.evil.example/')).toBe(false)
    expect(isApplyMateDashboardUrl('http://applymate.site/')).toBe(false)
  })

  it('recognizes expired bearer sessions without treating normal errors as auth failures', () => {
    expect(isAuthFailure({ status: 401 })).toBe(true)
    expect(isAuthFailure(new Error('Session expired'))).toBe(true)
    expect(isAuthFailure({ status: 403 })).toBe(false)
    expect(isAuthFailure(new Error('Network timeout'))).toBe(false)
  })
})
