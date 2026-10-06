import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiState = vi.hoisted(() => ({ turnsData: null as unknown }))
vi.mock('@/lib/hooks', () => ({ useApi: (url: string) => ({ data: url.includes('/turns?') ? apiState.turnsData : null, loading: false, error: null, refetch: () => undefined }) }))
vi.mock('./SelectedJobPreparationCard', () => ({ SelectedJobPreparationCard: () => null }))
vi.mock('./SelectedJobDraftArtifact', () => ({ SelectedJobDraftArtifact: () => null }))

import { translate } from '@/lib/i18n'
import { AgentSupervisorPanel, EvidenceSummary, projectSelectedEvidence } from './AgentSupervisorPanel'
import { projectSelectedTaskInterrupt } from './task-tree-projection'
import { TaskInterruptControl } from './TaskTreePanel'
import type { AgentTimelineSnapshot } from './use-agent-timeline'
import type { TimelineItem } from './timeline-reducer'
import type { TaskTreeNode } from './types'

function item(overrides: Partial<TimelineItem> = {}): TimelineItem {
  return {
    schemaVersion: 'agent-harness.v2', id: 'item-1', sessionId: 'session-1', turnId: 'turn-1', stepId: null, taskId: null,
    type: 'tool_result', status: 'completed', phase: 'commentary', revision: 1, content: { toolName: 'jobs.search', toolCallId: 'call-1', outputAvailable: true },
    startedAt: null, completedAt: null, createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z', source: 'replay', sequence: null, ...overrides,
  }
}

const t = (key: string) => translate('en', key)

beforeEach(() => { apiState.turnsData = null })

describe('AgentSupervisorPanel selected evidence', () => {
  it('projects an eligible selected child into the accessible interrupt action', () => {
    const task = {
      id: 'child-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1', parentTaskId: 'root-1',
      role: 'researcher', taskType: 'research', status: 'running', goal: 'Research roles', hasResult: false,
    }
    const turn = {
      id: 'turn-1', sessionId: 'session-1', source: 'message', goal: 'Find roles', status: 'in_progress', revision: 1,
      activeStepId: null, finalItemId: null, createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z', completedAt: null,
    }
    const node: TaskTreeNode = { id: 'task:child-1', kind: 'task', label: 'Research roles', status: 'running' }
    const projected = projectSelectedTaskInterrupt([task], [turn], node, [])
    expect(projected).toMatchObject({ task: { id: 'child-1' }, status: null, eligible: true })

    const html = renderToStaticMarkup(<TaskInterruptControl sessionId="session-1" taskId={projected!.task.id} taskLabel={node.label} eligible={projected!.eligible} status={projected!.status} onAccepted={vi.fn()} />)
    expect(html).toContain('Interrupt task and descendants')
    expect(html).toContain('Research roles and all descendants?')
    expect(html).toContain('role="alertdialog"')
  })

  it('keeps the supervisor hidden when no session is selected', () => {
    const timeline = {
      sessionId: null,
      items: [],
      lastEventId: null,
      lifecycleRevision: 0,
      cognitiveAgenda: null,
      cognitiveAgendas: [],
      approvalLedger: { sessionId: 'draft', approvals: [], pending: [], pendingActions: [], currentPending: null, pendingCount: 0 },
      connection: 'idle',
      restoring: false,
      error: null,
    } satisfies AgentTimelineSnapshot

    expect(renderToStaticMarkup(<AgentSupervisorPanel sessionId={null} timeline={timeline} />)).toBe('')
  })

  it('feeds a scoped active Turn projection to question lookup without adding it to the tree', () => {
    const pageTurns = Array.from({ length: 100 }, (_, index) => ({
      id: `turn-${index}`, sessionId: 'session-1', source: 'user', goal: `Goal ${index}`, status: 'completed', revision: 1,
      activeStepId: null, finalItemId: null, createdAt: '', updatedAt: '', completedAt: null,
    }))
    apiState.turnsData = {
      turns: pageTurns,
      projection: { activeTurnId: 'turn-current', activeTurn: { id: 'turn-current', status: 'waiting_for_user', revision: 14, goal: 'PROJECTION_PRIVATE_GOAL' } },
    }
    const question = item({ type: 'question', status: 'started', turnId: 'turn-current', content: {
      waitKind: 'question', questionId: 'question-current', stage: 'profile', question: 'Choose an option?',
      options: [{ value: 'yes', label: 'Yes' }], pending: true, answerAvailable: false,
    } })
    const timeline = {
      sessionId: 'session-1', items: [question], lastEventId: null, lifecycleRevision: 0, cognitiveAgenda: null, cognitiveAgendas: [],
      approvalLedger: { sessionId: 'session-1', approvals: [], pending: [], pendingActions: [], currentPending: null, pendingCount: 0 },
      connection: 'connected', restoring: false, error: null,
    } satisfies AgentTimelineSnapshot

    const html = renderToStaticMarkup(<AgentSupervisorPanel sessionId="session-1" timeline={timeline} />)
    const optionButton = html.match(/<button[^>]*>Yes<\/button>/)?.[0]
    expect(optionButton).toBeDefined()
    expect(optionButton).not.toContain('disabled=""')
    expect(html).not.toContain(translate('en', 'agent.question.turnUnavailable'))
    expect(html).not.toContain('PROJECTION_PRIVATE_GOAL')
  })

  it('projects bounded audit metadata and renders only safe references', () => {
    const selected = item({ content: {
      toolName: 'jobs.search', toolCallId: 'call-safe', input: { query: 'private input' }, status: 'completed', output: { evidenceRefs: ['read:job:job-2'], raw: 'RAW_OUTPUT_SHOULD_NOT_RENDER' }, errorCode: null, outputAvailable: true,
      parts: [
        { type: 'citation', evidenceId: 'read:job:job-1', label: 'private citation label' },
        { type: 'artifact_card', artifactId: 'artifact-1', label: 'private artifact label' },
      ],
    } })
    const projection = projectSelectedEvidence(selected)
    expect(projection).toEqual({ itemId: 'item-1', type: 'tool_result', status: 'completed', toolName: 'jobs.search', toolCallId: 'call-safe', resultAvailable: true, referenceIds: ['read:job:job-1', 'artifact-1', 'read:job:job-2'] })
    const html = renderToStaticMarkup(<EvidenceSummary item={selected} t={t} />)
    expect(html).toContain('jobs.search')
    expect(html).toContain('call-safe')
    expect(html).toContain('read:job:job-1')
    expect(html).toContain('read:job:job-2')
    expect(html).toContain('artifact-1')
    expect(html).not.toContain('RAW_OUTPUT_SHOULD_NOT_RENDER')
    expect(html).not.toContain('private citation label')
    expect(html).not.toContain('private artifact label')
    expect(html).not.toContain('session-1')
  })

  it('ignores raw output and nested identity-bearing values', () => {
    const selected = item({ content: {
      toolName: 'jobs.search', toolCallId: 'call-safe',
      output: { rawSecret: 'RAW_OUTPUT_SECRET', token: 'TOKEN_SECRET', apiKey: 'API_KEY_SECRET', userId: 'USER_SECRET', sessionId: 'SESSION_SECRET', leaseId: 'LEASE_SECRET', budget: 'BUDGET_SECRET', credential: 'CREDENTIAL_SECRET' },
    } })
    const projection = projectSelectedEvidence(selected)
    expect(projection).toMatchObject({ toolName: 'jobs.search', toolCallId: 'call-safe', referenceIds: [], resultAvailable: true })
    const html = renderToStaticMarkup(<EvidenceSummary item={selected} t={t} />)
    for (const secret of ['RAW_OUTPUT_SECRET', 'TOKEN_SECRET', 'API_KEY_SECRET', 'USER_SECRET', 'SESSION_SECRET', 'LEASE_SECRET', 'BUDGET_SECRET', 'CREDENTIAL_SECRET']) expect(html).not.toContain(secret)
  })

  it('rejects identity-bearing fields at the projection boundary', () => {
    const selected = item({ content: { toolName: 'jobs.search', toolCallId: 'call-safe', apiKey: 'API_KEY_SECRET', sessionId: 'SESSION_SECRET' } })
    expect(projectSelectedEvidence(selected)).toMatchObject({ toolName: null, toolCallId: null, referenceIds: [] })
  })

  it('fails closed for cyclic, oversized, malformed, and throwing content', () => {
    const cyclic: Record<string, unknown> = { toolName: 'jobs.search', parts: [] }
    ;(cyclic.parts as unknown[]).push(cyclic.parts)
    const oversized = { toolName: 'jobs.search', text: 'OVERSIZED_SECRET'.repeat(400) }
    const malformed = { toolName: 'jobs.search', parts: [{ type: 'future_part', text: 'MALFORMED_SECRET' }] }
    const throwing: Record<string, unknown> = { toolName: 'jobs.search' }
    Object.defineProperty(throwing, 'toolCallId', { enumerable: true, get: () => { throw new Error('getter') } })
    for (const content of [cyclic, oversized, malformed, throwing]) {
      const projection = projectSelectedEvidence(item({ type: 'tool_call', content }))
      expect(projection).toMatchObject({ toolName: null, toolCallId: null, resultAvailable: false, referenceIds: [] })
    }
  })
})
