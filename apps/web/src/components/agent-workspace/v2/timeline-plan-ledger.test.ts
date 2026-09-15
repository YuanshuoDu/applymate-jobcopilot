import { describe, expect, it } from 'vitest'

import { createPlanLedgerState, parsePlanLedgerEvent, reducePlanLedger } from './timeline-plan-ledger'

describe('timeline plan ledger public module', () => {
  it('exports the strict parser and pure reducer together', () => {
    const revision = { schemaVersion: 'agent-harness.v2', id: 'revision', sessionId: 'session-1', turnId: 'turn-1', itemId: null, taskId: 'task-1', type: 'plan.revision', actor: 'orchestrator', sequence: '1', payload: { planCallId: 'plan-1', goalRevision: 1, planRevision: 1, basedOnPlanRevision: null } }
    expect(parsePlanLedgerEvent(revision, 'session-1')).not.toBeNull()
    expect(reducePlanLedger(createPlanLedgerState('session-1'), revision).currentPlan?.planRevision).toBe(1)
  })
})
