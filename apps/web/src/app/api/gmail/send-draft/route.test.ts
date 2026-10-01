import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getGoogleAccessToken: vi.fn(),
  gmailMessageFindFirst: vi.fn(),
  jobUpdate: vi.fn(),
  activityCreate: vi.fn(),
  transaction: vi.fn(),
  txQueryRaw: vi.fn(),
  txAgentTurnFindFirst: vi.fn(),
  txAgentTurnUpdateMany: vi.fn(),
  sessionCreate: vi.fn(),
  agentTurnFindFirst: vi.fn(),
  agentApprovalFindFirst: vi.fn(),
  issueLegacyReceipt: vi.fn(),
  clientReceipt: vi.fn(),
  resolveLegacyApproval: vi.fn(),
  validateLegacyReceipt: vi.fn(),
  consumeLegacyReceipt: vi.fn(),
  appendTranscriptEvent: vi.fn(),
  ensureV2Turn: vi.fn(),
}))
const pinnedFetch = vi.hoisted(() => vi.fn((input: string | URL, init?: unknown) => globalThis.fetch(String(input), init as RequestInit)))

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
    agentTurn: { findFirst: mocks.agentTurnFindFirst },
    agentApproval: { findFirst: mocks.agentApprovalFindFirst },
    activity: { create: mocks.activityCreate },
    $transaction: mocks.transaction,
  },
}))

describe('POST /api/gmail/send-draft', () => {
  let turnStatus: 'in_progress' | 'interrupted'

  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    turnStatus = 'in_progress'
    mocks.requireAuth.mockResolvedValue({ userId: 'user-1' })
    mocks.getGoogleAccessToken.mockResolvedValue('gmail-token')
    mocks.gmailMessageFindFirst.mockResolvedValue({ job: { id: 'job-1' } })
    mocks.jobUpdate.mockResolvedValue({})
    mocks.activityCreate.mockResolvedValue({})
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      $queryRaw: mocks.txQueryRaw,
      agentTurn: { findFirst: mocks.txAgentTurnFindFirst, updateMany: mocks.txAgentTurnUpdateMany },
      job: { update: mocks.jobUpdate },
      activity: { create: mocks.activityCreate },
    }))
    mocks.txQueryRaw.mockResolvedValue([{ id: 'session_1' }])
    mocks.txAgentTurnFindFirst.mockImplementation(async () => ({ id: 'turn_1', status: turnStatus }))
    mocks.txAgentTurnUpdateMany.mockImplementation(async () => {
      if (turnStatus === 'interrupted') return { count: 0 }
      turnStatus = 'in_progress'
      return { count: 1 }
    })
    mocks.sessionCreate.mockResolvedValue({ id: 'session_1' })
    mocks.agentTurnFindFirst.mockResolvedValue({ revision: 0 })
    mocks.agentApprovalFindFirst.mockResolvedValue({
      id: 'approval_1', type: 'send_gmail', payload: {}, turnId: 'turn_1', toolCallId: 'gmail-send:1', jobId: 'job-1',
      revision: 0, expiresAt: new Date(Date.now() + 60_000),
    })
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
      method: 'POST', body: JSON.stringify({ to: 'recruiter@example.com', subject: 'Re: Interview', draft: 'Thank you.', gmailMessageId: 'gmail-1', threadId: 'thread-1', messageKind: 'interview_invitation' }),
    }) as never)
    await expect(firstResponse.json()).resolves.toMatchObject({ approvalRequired: true, sessionId: 'session_1', approval: { id: 'approval_1', receiptNonce: 'nonce_1' } })

    const response = await POST(new Request('http://localhost/api/gmail/send-draft', {
      method: 'POST', body: JSON.stringify({ to: 'recruiter@example.com', subject: 'Re: Interview', draft: 'Thank you.', gmailMessageId: 'gmail-1', threadId: 'thread-1', messageKind: 'interview_invitation', approvalId: 'approval_1', receiptNonce: 'nonce_1', sessionId: 'session_1' }),
    }) as never)

    await expect(response.json()).resolves.toMatchObject({ sent: true, tracked: true, jobId: 'job-1' })
    expect(mocks.agentApprovalFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'approval_1', sessionId: 'session_1', userId: 'user-1', status: 'pending', type: 'send_gmail' },
    }))
    expect(mocks.validateLegacyReceipt).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      approvalId: 'approval_1', userId: 'user-1', sessionId: 'session_1', turnId: 'turn_1', jobId: 'job-1', nonce: 'nonce_1',
    }))
    expect(mocks.txQueryRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.txAgentTurnFindFirst.mock.invocationCallOrder[0])
    expect(mocks.txAgentTurnFindFirst).toHaveBeenCalledWith({
      where: { id: 'turn_1', sessionId: 'session_1', userId: 'user-1' },
      select: { id: true, status: true },
    })
    expect(mocks.txAgentTurnUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'turn_1', sessionId: 'session_1', userId: 'user-1',
        status: { in: ['queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user'] },
      },
      data: { status: 'in_progress' },
    })
    expect(mocks.consumeLegacyReceipt).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      approvalId: 'approval_1', userId: 'user-1', sessionId: 'session_1', turnId: 'turn_1',
      reservationKey: 'gmail-send:approval_1',
    }))
    expect(fetch).toHaveBeenNthCalledWith(1, 'https://gmail.googleapis.com/gmail/v1/users/me/profile', expect.objectContaining({
      headers: { Authorization: 'Bearer gmail-token' },
    }))
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', expect.objectContaining({ body: expect.stringContaining('"threadId":"thread-1"') }))
    expect(mocks.jobUpdate).toHaveBeenCalledWith({ where: { id: 'job-1' }, data: { followUpAt: null } })
    expect(mocks.activityCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ jobId: 'job-1', type: 'email_sent' }) }))
  })

  it('keeps a Stop that commits before the continuation fence from reaching Gmail', async () => {
    const providerFetch = vi.fn()
    vi.stubGlobal('fetch', providerFetch)
    mocks.resolveLegacyApproval.mockImplementationOnce(async () => {
      // Deterministically place Stop between approval resolution and Turn resume.
      turnStatus = 'interrupted'
    })
    const { POST } = await import('./route')

    const response = await POST(new Request('http://localhost/api/gmail/send-draft', {
      method: 'POST', body: JSON.stringify({
        to: 'recruiter@example.com', draft: 'Thank you.', gmailMessageId: 'gmail-1',
        approvalId: 'approval_1', receiptNonce: 'nonce_1', sessionId: 'session_1',
      }),
    }) as never)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'Approval turn is no longer active' })
    expect(turnStatus).toBe('interrupted')
    expect(mocks.txQueryRaw).toHaveBeenCalledOnce()
    expect(mocks.txAgentTurnFindFirst).toHaveBeenCalledOnce()
    expect(mocks.txAgentTurnFindFirst).toHaveBeenCalledWith({
      where: { id: 'turn_1', sessionId: 'session_1', userId: 'user-1' },
      select: { id: true, status: true },
    })
    expect(mocks.txAgentTurnUpdateMany).not.toHaveBeenCalled()
    expect(mocks.consumeLegacyReceipt).not.toHaveBeenCalled()
    expect(providerFetch).not.toHaveBeenCalled()
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
})
