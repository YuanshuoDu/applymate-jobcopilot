import { describe, expect, it, vi } from 'vitest'

import {
  AgentApprovalActionError,
  createAgentApprovalMessageId,
  isCurrentAgentApprovalRequest,
  postAgentApprovalDecision,
} from './approval-action'

const actionRef = { approvalId: 'approval-1', turnId: 'turn-1', taskId: null, action: 'submit_application' }

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

  it('keeps the render-time session and selection fence deterministic', () => {
    expect(isCurrentAgentApprovalRequest(2, 2, 'session-1:approval-1:turn-1:7', 'session-1:approval-1:turn-1:7')).toBe(true)
    expect(isCurrentAgentApprovalRequest(3, 2, 'same', 'same')).toBe(false)
    expect(isCurrentAgentApprovalRequest(2, 2, 'new-selection', 'old-selection')).toBe(false)
  })
})
