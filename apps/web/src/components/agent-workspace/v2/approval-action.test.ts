import { describe, expect, it, vi } from 'vitest'

import {
  AgentApprovalActionError,
  createAgentApprovalMessageId,
  isCurrentAgentApprovalRequest,
  postAgentApprovalDecision,
} from './approval-action'

const actionRef = { approvalId: 'approval-1', turnId: 'turn-1', taskId: null, action: 'submit_application' }
const reviewedActionRef = { approvalId: 'reviewed-application-review:turn-1', turnId: 'turn-1', taskId: 'application-1', action: 'review_application' }
const receiptNonce = 'a'.repeat(64)

describe('approval action command', () => {
  it('posts only the Broker contract with one id in body and header', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ disposition: 'resolved' }), { status: 202 }))
    const clientMessageId = createAgentApprovalMessageId()
    await expect(postAgentApprovalDecision({ sessionId: 'session/1', actionRef, expectedRevision: 7, decision: 'approved', clientMessageId }, fetcher)).resolves.toEqual({ disposition: 'resolved' })

    expect(fetcher).toHaveBeenCalledWith('/api/agent/sessions/session%2F1/approvals/approval-1', expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': clientMessageId },
      body: JSON.stringify({ clientMessageId, expectedTurnId: 'turn-1', expectedRevision: 7, decision: 'approved' }),
    }))
    const request = fetcher.mock.calls[0]?.[1] as RequestInit
    expect(String(request.body)).not.toContain('scopeHash')
    expect(String(request.body)).not.toContain('taskId')
  })

  it('accepts duplicate acknowledgement but rejects non-202 or malformed responses generically', async () => {
    const duplicate = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ disposition: 'duplicate', message: 'private server detail' }), { status: 202 }))
    await expect(postAgentApprovalDecision({ sessionId: 'session-1', actionRef, expectedRevision: 1, decision: 'rejected', clientMessageId: 'message-duplicate' }, duplicate)).resolves.toEqual({ disposition: 'duplicate' })

    const conflict = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'wait_not_pending', message: 'private server detail' } }), { status: 409 }))
    await expect(postAgentApprovalDecision({ sessionId: 'session-1', actionRef, expectedRevision: 1, decision: 'rejected', clientMessageId: 'message-conflict' }, conflict)).rejects.toMatchObject({ status: 409 })
    await expect(postAgentApprovalDecision({ sessionId: 'session-1', actionRef, expectedRevision: 1, decision: 'rejected', clientMessageId: 'message-conflict-2' }, vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 202 })))).rejects.toBeInstanceOf(AgentApprovalActionError)
    await expect(postAgentApprovalDecision({ sessionId: 'session-1', actionRef, expectedRevision: 1, decision: 'rejected', clientMessageId: 'message-conflict-3' }, vi.fn<typeof fetch>().mockRejectedValue(new Error('private network detail')))).rejects.toMatchObject({ status: 0 })
  })

  it('refreshes the exact reviewed receipt only after explicit approval and posts its bounded nonce', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ approvalId: reviewedActionRef.approvalId, receiptNonce }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ disposition: 'resolved' }), { status: 202 }))
    const clientMessageId = 'review-decision-1'
    await expect(postAgentApprovalDecision({ sessionId: 'session-1', actionRef: reviewedActionRef, expectedRevision: 4,
      decision: 'approved', clientMessageId }, fetcher)).resolves.toEqual({ disposition: 'resolved' })

    const url = `/api/agent/sessions/session-1/approvals/${encodeURIComponent(reviewedActionRef.approvalId)}`
    expect(fetcher).toHaveBeenNthCalledWith(1, url, { method: 'GET', cache: 'no-store', credentials: 'same-origin' })
    expect(fetcher).toHaveBeenNthCalledWith(2, url, expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': clientMessageId },
      body: JSON.stringify({ clientMessageId, expectedTurnId: 'turn-1', expectedRevision: 4, decision: 'approved', receiptNonce }),
    }))
  })

  it.each([
    ['GET error', 404, { error: 'not found' }],
    ['mismatched approval id', 200, { approvalId: 'other-approval', receiptNonce }],
    ['malformed nonce', 200, { approvalId: reviewedActionRef.approvalId, receiptNonce: 'not-a-nonce' }],
  ])('does not POST after %s', async (_name, status, value) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(value), { status }))
    await expect(postAgentApprovalDecision({ sessionId: 'session-1', actionRef: reviewedActionRef, expectedRevision: 4,
      decision: 'approved', clientMessageId: 'review-decision-invalid' }, fetcher)).rejects.toBeInstanceOf(AgentApprovalActionError)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('retries one ambiguous reviewed POST with the same nonce and client key', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ approvalId: reviewedActionRef.approvalId, receiptNonce }), { status: 200 }))
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ disposition: 'duplicate' }), { status: 202 }))
    const clientMessageId = 'review-decision-retry'
    await expect(postAgentApprovalDecision({ sessionId: 'session-1', actionRef: reviewedActionRef, expectedRevision: 4,
      decision: 'approved', clientMessageId }, fetcher)).resolves.toEqual({ disposition: 'duplicate' })
    expect(fetcher).toHaveBeenCalledTimes(3)
    const firstPost = fetcher.mock.calls[1]?.[1] as RequestInit
    const retryPost = fetcher.mock.calls[2]?.[1] as RequestInit
    expect(retryPost.body).toBe(firstPost.body)
    expect(retryPost.headers).toEqual(firstPost.headers)
    expect(String(retryPost.body)).toContain(receiptNonce)
  })

  it('does not fetch or send a nonce for rejection, legacy review, or ordinary approvals', async () => {
    const rejected = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ disposition: 'resolved' }), { status: 202 }))
    await postAgentApprovalDecision({ sessionId: 'session-1', actionRef: reviewedActionRef, expectedRevision: 4,
      decision: 'rejected', clientMessageId: 'review-reject' }, rejected)
    expect(rejected).toHaveBeenCalledTimes(1)
    expect(String((rejected.mock.calls[0]?.[1] as RequestInit).body)).not.toContain('receiptNonce')

    const legacy = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ disposition: 'resolved' }), { status: 202 }))
    await postAgentApprovalDecision({ sessionId: 'session-1', actionRef: { ...reviewedActionRef, approvalId: 'legacy-review-1' },
      expectedRevision: 4, decision: 'approved', clientMessageId: 'legacy-review' }, legacy)
    expect(legacy).toHaveBeenCalledTimes(1)
    expect(String((legacy.mock.calls[0]?.[1] as RequestInit).body)).not.toContain('receiptNonce')

    const ordinary = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ disposition: 'resolved' }), { status: 202 }))
    await postAgentApprovalDecision({ sessionId: 'session-1', actionRef, expectedRevision: 4,
      decision: 'approved', clientMessageId: 'ordinary-approve' }, ordinary)
    expect(ordinary).toHaveBeenCalledTimes(1)
    expect(String((ordinary.mock.calls[0]?.[1] as RequestInit).body)).not.toContain('receiptNonce')
  })

  it('keeps the render-time session and selection fence deterministic', () => {
    expect(isCurrentAgentApprovalRequest(2, 2, 'session-1:approval-1:turn-1:7', 'session-1:approval-1:turn-1:7')).toBe(true)
    expect(isCurrentAgentApprovalRequest(3, 2, 'same', 'same')).toBe(false)
    expect(isCurrentAgentApprovalRequest(2, 2, 'new-selection', 'old-selection')).toBe(false)
  })
})
