import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('../db/apply-results.js', () => ({
  getPool: vi.fn(() => ({ query: mocks.query })),
}))

vi.mock('@jobcopilot/shared', () => ({
  pinnedFetch: vi.fn().mockResolvedValue(new Response('{}', { status: 200 })),
}))

describe('notifyApplyResult', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('RESEND_API_KEY', 'resend-test-key')
    mocks.query.mockResolvedValue({ rows: [{ email: 'candidate@example.com', name: 'Candidate', preferences: {} }] })
  })

  it('does not send an apply email when the user disabled apply notifications', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ email: 'candidate@example.com', name: 'Candidate', preferences: { notificationPreferences: { apply: false } } }] })

    const { notifyApplyResult } = await import('./notify-apply-result.js')
    const { pinnedFetch } = await import('@jobcopilot/shared')
    await notifyApplyResult({ userId: 'user-1', jobTitle: 'Engineer', jobCompany: 'Acme', status: 'submitted' })

    expect(pinnedFetch).not.toHaveBeenCalled()
  })

  it('uses the apply preference for failed application emails', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ email: 'candidate@example.com', name: 'Candidate', preferences: { notificationPreferences: { apply: false, reject: true } } }] })

    const { notifyApplyResult } = await import('./notify-apply-result.js')
    const { pinnedFetch } = await import('@jobcopilot/shared')
    await notifyApplyResult({ userId: 'user-1', jobTitle: 'Engineer', jobCompany: 'Acme', status: 'failed' })

    expect(pinnedFetch).not.toHaveBeenCalled()
  })

  it('sends a distinct submission blocked email', async () => {
    const { notifyApplyResult } = await import('./notify-apply-result.js')
    const { pinnedFetch } = await import('@jobcopilot/shared')
    await notifyApplyResult({ userId: 'user-1', jobTitle: 'Engineer', jobCompany: 'Acme', status: 'submission_blocked' })

    expect(pinnedFetch).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        body: expect.stringContaining('Submission blocked: Acme'),
      }),
    )
  })
})
