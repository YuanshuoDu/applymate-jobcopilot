import { describe, expect, it } from 'vitest'
import { toAdminApplicationMetadata } from './application-dto'

describe('toAdminApplicationMetadata', () => {
  it('maps raw errors to an allow-listed class without serializing error text', () => {
    const result = toAdminApplicationMetadata({ id: 1, userId: 'user-1', jobId: 'job-1', status: 'failed', mode: 'unattended', atsType: 'lever', flowUsed: 'llm', error: 'Captcha screenshot includes private candidate input', durationMs: 1200, createdAt: new Date('2026-08-05') })
    expect(result).toEqual(expect.objectContaining({ errorClass: 'captcha' }))
    expect(JSON.stringify(result)).not.toContain('private candidate input')
  })
})
