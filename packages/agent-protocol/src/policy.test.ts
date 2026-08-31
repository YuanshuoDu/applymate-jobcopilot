import { describe, expect, it } from 'vitest'

import { PolicyDecisionSchema, PolicySnapshotSchema, validate } from './index.js'

const decision = {
  schemaVersion: 'agent-harness.v2',
  policyVersion: 'policy.v1',
  hook: 'before_tool_use',
  outcome: 'deny',
  reasonCode: 'missing_policy',
  reason: 'External writes require an explicit policy',
  scope: {
    userId: 'user-a', sessionId: 'session-a', turnId: 'turn-a', stepId: 'step-a', toolCallId: 'call-a',
    toolName: 'application.submit', toolVersion: '1', role: 'orchestrator', domain: 'application', risk: 'external_write',
  },
}

describe('policy protocol', () => {
  it('accepts versioned decisions with immutable execution scope', () => {
    expect(validate(PolicyDecisionSchema, decision)).toBe(true)
  })

  it('rejects unknown hook, outcome, role, or risk values', () => {
    expect(validate(PolicyDecisionSchema, { ...decision, hook: 'arbitrary' })).toBe(false)
    expect(validate(PolicyDecisionSchema, { ...decision, outcome: 'maybe' })).toBe(false)
    expect(validate(PolicyDecisionSchema, { ...decision, scope: { ...decision.scope, role: 'user' } })).toBe(false)
    expect(validate(PolicyDecisionSchema, { ...decision, scope: { ...decision.scope, risk: 'admin' } })).toBe(false)
  })

  it('validates policy snapshots and keeps rewrite outside matrix rule outcomes', () => {
    expect(validate(PolicySnapshotSchema, {
      version: 'policy.v1', rules: [{ id: 'read', roles: ['orchestrator'], tools: ['jobs.search'], toolVersions: ['1'], risks: ['read'], domains: ['jobs'], outcome: 'allow', reasonCode: 'read_allowed', reason: 'Read is allowed' }],
    })).toBe(true)
    expect(validate(PolicySnapshotSchema, {
      version: 'policy.v1', rules: [{ id: 'bad', roles: ['orchestrator'], outcome: 'rewrite_input', reasonCode: 'bad', reason: 'Invalid matrix rule' }],
    })).toBe(false)
  })
})
