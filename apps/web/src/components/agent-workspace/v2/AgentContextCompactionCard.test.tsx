import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { I18nProvider, translate } from '@/lib/i18n'

import { AgentContextCompactionCard } from './AgentContextCompactionCard'
import { selectTimelineContextCompactionProjection } from './timeline-context-compaction'

const record = {
  eventId: 'event-1', sessionId: 'session-1', turnId: 'turn-1', taskId: 'task-1', sequence: '4', createdAt: null,
  status: 'compacted' as const, beforeInputTokens: 20, afterInputTokens: 8, beforeBytes: 80, afterBytes: 32,
  savedTokens: 12, savedBytes: 48, tokenReductionRatio: 0.6,
}

describe('AgentContextCompactionCard', () => {
  it('renders translated safe metrics without raw compaction identity or snapshot data', () => {
    const ledger = selectTimelineContextCompactionProjection({ records: [record] })
    const html = renderToStaticMarkup(<I18nProvider><AgentContextCompactionCard ledger={ledger} /></I18nProvider>)
    expect(html).toContain('data-agent-context-compaction="true"')
    expect(html).toContain(translate('en', 'agent.contextCompaction.title'))
    expect(html).toContain('Scope 1')
    expect(html).toContain('Saved tokens: 12')
    expect(html).toContain('60%')
    expect(html).not.toContain('event-1')
    expect(html).not.toContain('task-1')
    expect(html).not.toContain('snapshotRef')
    expect(html).not.toContain('idempotency')
    expect(html).not.toContain('<button')
  })

  it('renders a translated empty state', () => {
    const html = renderToStaticMarkup(<I18nProvider><AgentContextCompactionCard ledger={{ records: [] }} /></I18nProvider>)
    expect(html).toContain('data-agent-context-compaction-empty="true"')
    expect(html).toContain(translate('en', 'agent.contextCompaction.empty'))
  })
})
