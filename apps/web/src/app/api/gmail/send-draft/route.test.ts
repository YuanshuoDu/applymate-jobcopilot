import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getGoogleAccessToken: vi.fn(),
  gmailMessageFindFirst: vi.fn(),
  jobUpdate: vi.fn(),
  activityCreate: vi.fn(),
  transaction: vi.fn(),
  sessionCreate: vi.fn(),
  agentTurnFindFirst: vi.fn(),
  agentApprovalFindFirst: vi.fn(),
  agentTurnUpdate: vi.fn(),
  issueLegacyReceipt: vi.fn(),
  clientReceipt: vi.fn(),
  resolveLegacyApproval: vi.fn(),
  validateLegacyReceipt: vi.fn(),
  consumeLegacyReceipt: vi.fn(),
  appendTranscriptEvent: vi.fn(),
  ensureV2Turn: vi.fn(),
}))
const pinnedFetch = vi.hoisted(() => vi.fn((input: string | URL, init?: unknown) => globalThis.fetch(String(input), init as RequestInit)))

function canonicalResolution(decision: 'approved' | 'rejected', disposition: 'resolved' | 'duplicate' = 'resolved') {
  return {
    disposition: 'canonical_wait',
    decision,
    result: {
      waitKind: 'approval',
      waitId: 'approval_1',
      itemId: 'agent-wait:approval:approval_1',
      turnId: 'turn_1',
      toolCallId: 'gmail-send:1',
      disposition,
      status: decision,
      nextTurnRevision: 1,
      sequence: '9',
    },
  }
}

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (error: string, status = 400) => Response.json({ error }, { status }),
}))
vi.mock('@jobcopilot/shared', async () => {
  const actual = await vi.importActual<typeof import('@jobcopilot/shared')>('@jobcopilot/shared')
  return { ...actual, pinnedFetch }
})
vi.mock('@/lib/gmail-helpers', () => ({ getGoogleAccessToken: mocks.getGoogleAccessToken }))
vi.mock('@/lib/agent/session/repository', () => ({
  createAgentSession: mocks.sessionCreate,
  appendTranscriptEvent: mocks.appendTranscriptEvent,
}))
vi.mock('@/lib/agent/session/v2-turn', () => ({ ensureV2Turn: mocks.ensureV2Turn }))
vi.mock('@/lib/agent/approval/legacy-receipt', () => ({
  clientReceipt: mocks.clientReceipt,
  consumeLegacyReceipt: mocks.consumeLegacyReceipt,
  issueLegacyReceipt: mocks.issueLegacyReceipt,
  resolveLegacyApproval: mocks.resolveLegacyApproval,
  validateLegacyReceipt: mocks.validateLegacyReceipt,
}))
vi.mock('@/lib/db', () => ({
  db: {
    gmailMessage: { findFirst: mocks.gmailMessageFindFirst },
    job: { findFirst: vi.fn(), update: mocks.jobUpdate },
    agentTurn: { findFirst: mocks.agentTurnFindFirst, update: mocks.agentTurnUpdate },
    agentApproval: { findFirst: mocks.agentApprovalFindFirst },
    activity: { create: mocks.activityCreate },
    $transaction: mocks.transaction,
  },
}))

describe('POST /api/gmail/send-draft', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAuth.mockResolvedValue({ userId: 'user-1' })
    mocks.getGoogleAccessToken.mockResolvedValue('gmail-token')
    mocks.gmailMessageFindFirst.mockResolvedValue({ job: { id: 'job-1' } })
    mocks.jobUpdate.mockResolvedValue({})
    mocks.activityCreate.mockResolvedValue({})
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      job: { update: mocks.jobUpdate },
      activity: { create: mocks.activityCreate },
    }))
    mocks.sessionCreate.mockResolvedValue({ id: 'session_1' })
    mocks.agentTurnFindFirst.mockResolvedValue({ revision: 0 })
    mocks.agentApprovalFindFirst.mockResolvedValue({
      id: 'approval_1', type: 'send_gmail', payload: {}, turnId: 'turn_1', toolCallId: 'gmail-send:1', jobId: 'job-1',
      revision: 0, expiresAt: new Date(Date.now() + 60_000),
    })
    mocks.agentTurnUpdate.mockResolvedValue({})
    mocks.issueLegacyReceipt.mockResolvedValue({
      approval: { id: 'approval_1', type: 'send_gmail', title: 'Confirm Gmail follow-up', body: 'Review the draft.' },
      nonce: 'nonce_1',
    })
    mocks.clientReceipt.mockImplementation((result: { approval: object; nonce: string }) => ({ ...result.approval, receiptNonce: result.nonce }))
    mocks.resolveLegacyApproval.mockResolvedValue(undefined)
    mocks.validateLegacyReceipt.mockResolvedValue({})
    mocks.consumeLegacyReceipt.mockResolvedValue({ approvalId: 'approval_1', reservationId: 'reservation_1', consumedAt: new Date() })
    mocks.appendTranscriptEvent.mockResolvedValue({})
    mocks.ensureV2Turn.mockResolvedValue({ sessionId: 'session_1', turnId: 'turn_1', revision: 0 })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ emailAddress: 'me@example.com' }))
      .mockResolvedValueOnce(Response.json({ id: 'sent-1' })))
  })

  it('sends a threaded follow-up and clears the matched job follow-up task', async () => {
    const { POST } = await import('./route')
    const firstResponse = await POST(new Request('http://localhost/api/gmail/send-draft', {
      method: 'POST', body: JSON.stringify({ to: 'recruiter@example.com', subject: 'Re: Interview', draft: 'Thank you.', gmailMessageId: 'gmail-1', threadId: 'thread-1', messageKind: 'interview_invitation', approvalId: null, sessionId: null, receiptNonce: null }),
    }) as never)
    await expect(firstResponse.json()).resolves.toMatchObject({ approvalRequired: true, sessionId: 'session_1', approval: { id: 'approval_1', receiptNonce: 'nonce_1' } })

    const response = await POST(new Request('http://localhost/api/gmail/send-draft', {
      method: 'POST', body: JSON.stringify({ to: 'recruiter@example.com', subject: 'Re: Interview', draft: 'Thank you.', gmailMessageId: 'gmail-1', threadId: 'thread-1', messageKind: 'interview_invitation', approvalId: 'approval_1', receiptNonce: 'nonce_1', sessionId: 'session_1' }),
    }) as never)

    await expect(response.json()).resolves.toMatchObject({ sent: true, tracked: true, jobId: 'job-1' })
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', expect.objectContaining({ body: expect.stringContaining('"threadId":"thread-1"') }))
    expect(mocks.getGoogleAccessToken).toHaveBeenCalledTimes(2)
    expect(mocks.jobUpdate).toHaveBeenCalledWith({ where: { id: 'job-1' }, data: { followUpAt: null } })
    expect(mocks.activityCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ jobId: 'job-1', type: 'email_sent' }) }))
  })

  it('returns only a stable status when Gmail rejects a send', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ emailAddress: 'me@example.com' }))
      .mockResolvedValueOnce(new Response('{"error":"private provider response"}', { status: 429 })))
    const { POST } = await import('./route')

    const response = await POST(new Request('http://localhost/api/gmail/send-draft', {
      method: 'POST', body: JSON.stringify({ to: 'recruiter@example.com', draft: 'Thank you.', gmailMessageId: 'gmail-1', approvalId: 'approval_1', receiptNonce: 'nonce_1', sessionId: 'session_1' }),
    }) as never)

    await expect(response.json()).resolves.toEqual({ error: 'Gmail send failed (HTTP 429)' })
  })

  it('keeps a legacy-only approval pending when the token is unavailable', async () => {
    mocks.getGoogleAccessToken.mockResolvedValueOnce(null)
    mocks.resolveLegacyApproval.mockImplementationOnce(async (_db, _input, options) => {
      await options?.beforeLegacyOnlyResolve?.()
      return { disposition: 'legacy_only', decision: 'approved' }
    })
    const { POST } = await import('./route')

    const response = await POST(new Request('http://localhost/api/gmail/send-draft', {
      method: 'POST', body: JSON.stringify({
        to: 'recruiter@example.com', draft: 'Thank you.', gmailMessageId: 'gmail-1',
        approvalId: 'approval_1', receiptNonce: 'nonce_1', sessionId: 'session_1',
      }),
    }) as never)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Gmail not connected. Please connect Google account in Settings.' })
    expect(mocks.getGoogleAccessToken).toHaveBeenCalledTimes(1)
    expect(mocks.agentTurnUpdate).not.toHaveBeenCalled()
    expect(mocks.consumeLegacyReceipt).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not create a fresh approval for a partial approval context', async () => {
    const { POST } = await import('./route')

    const response = await POST(new Request('http://localhost/api/gmail/send-draft', {
      method: 'POST', body: JSON.stringify({
        to: 'recruiter@example.com', draft: 'Thank you.', gmailMessageId: 'gmail-1', approvalId: 'approval_1',
      }),
    }) as never)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'The Gmail approval context is incomplete.' })
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
    expect(mocks.issueLegacyReceipt).not.toHaveBeenCalled()
    expect(mocks.getGoogleAccessToken).not.toHaveBeenCalled()
    expect(mocks.agentApprovalFindFirst).not.toHaveBeenCalled()
  })

  it('rejects unsupported approval decisions before resolving a Gmail approval', async () => {
    const { POST } = await import('./route')

    const response = await POST(new Request('http://localhost/api/gmail/send-draft', {
      method: 'POST', body: JSON.stringify({
        to: 'recruiter@example.com', draft: 'Thank you.', gmailMessageId: 'gmail-1', decision: 'cancelled',
      }),
    }) as never)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid Gmail approval decision.' })
    expect(mocks.gmailMessageFindFirst).not.toHaveBeenCalled()
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
    expect(mocks.resolveLegacyApproval).not.toHaveBeenCalled()
  })

  it.each([
    ['approved', 'approved'],
    ['rejected', 'rejected'],
  ] as const)('returns a 202 canonical %s disposition without Gmail side effects', async (decision, expectedDisposition) => {
    mocks.resolveLegacyApproval.mockResolvedValueOnce(canonicalResolution(decision))
    const { POST } = await import('./route')

    const response = await POST(new Request('http://localhost/api/gmail/send-draft', {
      method: 'POST', body: JSON.stringify({
        to: 'recruiter@example.com', draft: 'Thank you.', gmailMessageId: 'gmail-1',
        approvalId: 'approval_1', sessionId: 'session_1', ...(decision === 'approved' ? { receiptNonce: 'nonce_1' } : {}), decision,
      }),
    }) as never)

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toEqual({ sent: false, disposition: expectedDisposition, duplicate: false })
    expect(mocks.resolveLegacyApproval).toHaveBeenCalledTimes(1)
    expect(mocks.getGoogleAccessToken).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.agentTurnUpdate).not.toHaveBeenCalled()
    expect(mocks.consumeLegacyReceipt).not.toHaveBeenCalled()
    expect(mocks.jobUpdate).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
  })

  it('fails closed when another approval wait is active in the same Turn', async () => {
    mocks.resolveLegacyApproval.mockRejectedValueOnce(Object.assign(new Error('Another approval wait is already active for this Turn'), { code: 'approval_wait_active' }))
    const { POST } = await import('./route')

    const response = await POST(new Request('http://localhost/api/gmail/send-draft', {
      method: 'POST', body: JSON.stringify({
        to: 'recruiter@example.com', draft: 'Thank you.', gmailMessageId: 'gmail-1',
        approvalId: 'approval_1', receiptNonce: 'nonce_1', sessionId: 'session_1',
      }),
    }) as never)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'Another approval wait is already active for this Turn', code: 'approval_wait_active' })
    expect(mocks.getGoogleAccessToken).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.agentTurnUpdate).not.toHaveBeenCalled()
    expect(mocks.consumeLegacyReceipt).not.toHaveBeenCalled()
    expect(mocks.jobUpdate).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
  })
})
