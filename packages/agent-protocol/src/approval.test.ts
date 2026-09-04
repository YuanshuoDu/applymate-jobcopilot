import { describe, expect, it } from 'vitest'
import { validate } from './validation.js'
import { AgentApprovalSchema, serializeApprovalScope } from './approval.js'

const approval = {
  schemaVersion: 'agent-harness.v2',
  id: 'approval-1',
  type: 'submit_application',
  status: 'pending',
  title: 'Submit application',
  body: 'Review the application before submission.',
  scope: {
    userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', jobId: 'job-1', toolCallId: 'call-1',
    action: 'submit_application', resourceHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    materialHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    answersHash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    revision: 0, nonceHash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    expiresAt: '2026-08-31T01:00:00.000Z',
  },
  scopeHash: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  payload: { jobId: 'job-1' },
  decidedAt: null,
  consumedAt: null,
  createdAt: '2026-08-31T00:00:00.000Z',
}

describe('AgentApproval schema', () => {
  it('accepts a scoped pending approval', () => {
    expect(validate(AgentApprovalSchema, approval)).toBe(true)
  })

  it('accepts artifact hashes with the canonical sha256 prefix', () => {
    expect(validate(AgentApprovalSchema, {
      ...approval,
      scope: {
        ...approval.scope,
        resourceHash: `sha256:${'a'.repeat(64)}`,
      },
    })).toBe(true)
  })

  it('rejects an unknown scoped action and unknown status', () => {
    expect(validate(AgentApprovalSchema, { ...approval, scope: { ...approval.scope, action: 'unknown_action' } })).toBe(false)
    expect(validate(AgentApprovalSchema, { ...approval, status: 'accepted' })).toBe(false)
  })

  it('serializes a scope with a stable field order', () => {
    expect(serializeApprovalScope(approval.scope)).toBe(JSON.stringify({
      version: 1,
      userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', jobId: 'job-1', toolCallId: 'call-1',
      action: 'submit_application', resourceHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      materialHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      answersHash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      revision: 0, nonceHash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      expiresAt: '2026-08-31T01:00:00.000Z',
    }))
  })
})
