import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { translate } from '@/lib/i18n'
import { EvidenceSummary, projectSelectedEvidence, SupervisorControlSummary } from './AgentSupervisorPanel'
import type { TimelineItem } from './timeline-reducer'

function item(overrides: Partial<TimelineItem> = {}): TimelineItem {
  return {
    schemaVersion: 'agent-harness.v2', id: 'item-1', sessionId: 'session-1', turnId: 'turn-1', stepId: null, taskId: null,
    type: 'tool_result', status: 'completed', phase: 'commentary', revision: 1, content: { toolName: 'jobs.search', toolCallId: 'call-1', outputAvailable: true },
    startedAt: null, completedAt: null, createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z', source: 'replay', sequence: null, ...overrides,
  }
}

const t = (key: string) => translate('en', key)

describe('AgentSupervisorPanel control projection', () => {
  it('renders the server-owned gate and revision in the selected locale without payload data', () => {
    const html = renderToStaticMarkup(<SupervisorControlSummary controlGate="user_paused" controlRevision={12} t={key => translate('zh', key)} />)

    expect(html).toContain(`${translate('zh', 'agent.gate')}: ${translate('zh', 'agent.paused')}`)
    expect(html).toContain(`${translate('zh', 'agent.approvalLedger.revision')}: 12`)
    expect(html).toContain('data-agent-supervisor-control-gate="user_paused"')
    expect(html).toContain('data-agent-supervisor-control-revision="12"')
    expect(html).not.toContain('session-1')
    expect(html).not.toContain('raw')
    expect(html).not.toContain(translate('en', 'agent.paused'))
  })

  it('fails closed for an invalid control revision', () => {
    const html = renderToStaticMarkup(<SupervisorControlSummary controlGate="open" controlRevision={Number.NaN} t={t} />)

    expect(html).toContain(`${translate('en', 'agent.approvalLedger.revision')}: ${translate('en', 'agent.notAvailable')}`)
    expect(html).not.toContain('NaN')
  })
})

describe('AgentSupervisorPanel selected evidence', () => {
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
