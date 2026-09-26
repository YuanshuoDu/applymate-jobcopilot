import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { EvidenceSummary, projectSelectedEvidence } from './agent-supervisor-evidence'
import type { TimelineItem } from './timeline-reducer'

function item(content: unknown, type: TimelineItem['type'] = 'tool_result'): TimelineItem {
  return {
    schemaVersion: 'agent-harness.v2', id: 'item-1', sessionId: 'session-1', turnId: 'turn-1', stepId: null, taskId: null,
    type, status: 'completed', phase: 'commentary', revision: 1, content,
    startedAt: null, completedAt: null, createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z', source: 'replay', sequence: null,
  }
}

const t = (key: string) => key

describe('supervisor evidence projection', () => {
  it('renders safe references while keeping opaque output private', () => {
    const selected = item({
      toolName: 'jobs.search', toolCallId: 'call-safe', outputAvailable: true,
      output: { evidenceRefs: ['read:job:job-1'], raw: 'PRIVATE_OUTPUT' },
    })

    expect(projectSelectedEvidence(selected).referenceIds).toEqual(['read:job:job-1'])
    const html = renderToStaticMarkup(<EvidenceSummary item={selected} t={t} />)
    expect(html).toContain('read:job:job-1')
    expect(html).not.toContain('PRIVATE_OUTPUT')
  })

  it('fails closed for identity-bearing content', () => {
    const projection = projectSelectedEvidence(item({ toolName: 'jobs.search', toolCallId: 'call-safe', apiKey: 'SECRET' }, 'tool_call'))

    expect(projection).toMatchObject({ toolName: null, toolCallId: null, resultAvailable: false, referenceIds: [] })
  })
})
