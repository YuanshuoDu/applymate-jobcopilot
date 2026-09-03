import { describe, expect, it } from 'vitest'
import {
  approvalPresentation,
  artifactViewState,
  budgetViewState,
  isHeartbeatEvent,
  isNoiseEvent,
  projectTaskTree,
} from './agent-workspace-projection'

const task = (id: string, parentTaskId?: string | null) => ({
  id, parentTaskId, role: 'scout', taskType: 'search', status: 'running', goal: id,
})

describe('agent workspace projections', () => {
  it('projects nested tasks deterministically and exposes orphan parents', () => {
    const tree = projectTaskTree([task('child', 'root'), task('orphan', 'missing'), task('root'), task('cycle-a', 'cycle-b'), task('cycle-b', 'cycle-a')])
    expect(tree.map(node => node.task.id)).toEqual(['cycle-a', 'cycle-b', 'orphan', 'root'])
    expect(tree.find(node => node.task.id === 'root')?.children.map(node => node.task.id)).toEqual(['child'])
    expect(tree.find(node => node.task.id === 'orphan')?.orphaned).toBe(true)
  })

  it('fails closed for missing, answered, expired, and cross-turn approvals', () => {
    const scope = { sessionId: 'session-1', turnId: 'turn-1', jobId: 'job-1', toolCallId: 'call-1', action: 'submit_application', scopeHash: 'scope-hash' }
    expect(approvalPresentation({ approvalId: 'approval-1', status: 'pending', scope }).canAct).toBe(true)
    expect(approvalPresentation({ approvalId: 'approval-1', status: 'approved', scope }).state).toBe('answered')
    expect(approvalPresentation({ approvalId: 'approval-1', status: 'pending', scope, currentTurnId: 'turn-2' }).state).toBe('stale')
    expect(approvalPresentation({ approvalId: 'approval-1', status: 'pending', scope: { ...scope, expiresAt: '2026-09-03T00:00:00.000Z' }, now: new Date('2026-09-03T00:00:01.000Z') }).state).toBe('expired')
    expect(approvalPresentation({ approvalId: 'approval-1', status: 'pending', scope: { sessionId: 'session-1' } }).state).toBe('unavailable')
  })

  it('marks artifact and budget freshness without guessing incomplete state', () => {
    expect(artifactViewState({ hash: 'hash', version: 2 })).toBe('current')
    expect(artifactViewState({ hash: 'hash', version: 2, stale: true })).toBe('stale')
    expect(artifactViewState({ hash: 'hash', version: 2, turnId: 'turn-1', currentTurnId: 'turn-2' })).toBe('stale')
    expect(artifactViewState({ hash: null, version: 2 })).toBe('uncertain')
    expect(budgetViewState(40, 100)).toBe('ok')
    expect(budgetViewState(85, 100)).toBe('near_limit')
    expect(budgetViewState(100, 100)).toBe('exhausted')
    expect(budgetViewState(null, 100)).toBe('unknown')
  })

  it('classifies heartbeat events as noise for the collapse policy', () => {
    expect(isHeartbeatEvent('agent_heartbeat')).toBe(true)
    expect(isNoiseEvent('agent_heartbeat')).toBe(true)
    expect(isNoiseEvent('approval_request')).toBe(false)
  })
})
