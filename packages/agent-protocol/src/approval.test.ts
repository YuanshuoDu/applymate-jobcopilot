import { describe, expect, it } from 'vitest'
import { validate } from './validation.js'
import { AgentApprovalSchema } from './approval.js'

const approval = {
  schemaVersion: 'agent-harness.v2',
  id: 'approval-1',
  type: 'submit_application',
  status: 'pending',
  title: 'Submit application',
  body: 'Review the application before submission.',
  scope: {
    userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', toolCallId: 'call-1',
    action: 'submit_application', resourceHash: 'sha256-materials', expiresAt: '2026-08-31T01:00:00.000Z',
  },
  payload: { jobId: 'job-1' },
  decidedAt: null,
  createdAt: '2026-08-31T00:00:00.000Z',
}

describe('AgentApproval schema', () => {
  it('accepts a scoped pending approval', () => {
    expect(validate(AgentApprovalSchema, approval)).toBe(true)
  })

  it('rejects an unknown scoped action and unknown status', () => {
    expect(validate(AgentApprovalSchema, { ...approval, scope: { ...approval.scope, action: 'unknown_action' } })).toBe(false)
    expect(validate(AgentApprovalSchema, { ...approval, status: 'accepted' })).toBe(false)
  })
})
