import { describe, expect, it } from 'vitest'
import { toAdminUserMetadata } from './dto'

describe('toAdminUserMetadata', () => {
  it('masks PII and excludes private candidate content', () => {
    const result = toAdminUserMetadata({
      id: 'user-1', name: 'Jane Candidate', email: 'jane@example.com', plan: 'pro', location: 'Berlin', createdAt: new Date('2026-08-05'),
      password: 'hash', refresh_token: 'secret-token', resumeContent: 'private resume', gmailBody: 'private email',
      _count: { jobs: 2, resumes: 1, notifications: 3 }, gmailSyncState: { lastSyncedAt: null, lastError: null },
    } as never)
    expect(result).toEqual(expect.objectContaining({ email: 'ja***@example.com', location: 'B***', jobsCount: 2, resumeExists: true }))
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('hash')
    expect(serialized).not.toContain('secret-token')
    expect(serialized).not.toContain('private resume')
    expect(serialized).not.toContain('private email')
  })
})
