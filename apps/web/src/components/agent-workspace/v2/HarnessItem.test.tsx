import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { I18nProvider, translate } from '@/lib/i18n'
import { HarnessItem, ToolLifecycleCard, reducePlanSteps } from './HarnessItem'
import type { TimelineItem } from './timeline-reducer'

function item(overrides: Partial<TimelineItem> = {}): TimelineItem {
  return {
    schemaVersion: 'agent-harness.v2', id: 'item-1', sessionId: 'session-1', turnId: 'turn-1', stepId: null, taskId: null,
    type: 'agent_message', status: 'completed', phase: 'commentary', revision: 1, content: { parts: [{ type: 'text', text: 'Hello' }] },
    startedAt: null, completedAt: null, createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z', source: 'replay', sequence: null, ...overrides,
  }
}

describe('HarnessItem renderers', () => {
  it('visually distinguishes commentary and highlights a final item', () => {
    const html = renderToStaticMarkup(<I18nProvider><HarnessItem item={item({ phase: 'final_answer' })} highlightedFinal /></I18nProvider>)
    expect(html).toContain('data-agent-phase="final"')
    expect(html).toContain('data-agent-final="true"')
    expect(html).toContain('Final answer')
  })

  it('renders plan steps and the complete tool lifecycle state', () => {
    expect(reducePlanSteps({ steps: [{ id: 'one', title: 'Search roles', status: 'completed' }, 'Review matches'] })).toEqual([
      { id: 'one', label: 'Search roles', status: 'completed' }, { id: '1', label: 'Review matches', status: 'queued' },
    ])
    const html = renderToStaticMarkup(<I18nProvider><ToolLifecycleCard item={item({ type: 'tool_call', status: 'running', content: { toolName: 'jobs.search', input: { query: 'Berlin' } } })} /></I18nProvider>)
    expect(html).toContain('data-tool-lifecycle="true"')
    expect(html).toContain('data-tool-status="running"')
    expect(html).toContain('jobs.search')
  })

  it('uses a redaction and unknown-part fallback without serializing the raw payload', () => {
    const html = renderToStaticMarkup(<I18nProvider><HarnessItem item={item({ type: 'unknown', content: { future: '<script>secret</script>' } })} /></I18nProvider>)
    expect(html).toContain('Unknown agent item')
    expect(html).not.toContain('secret')
    expect(html).not.toContain('<script>')
  })

  it('only reports a suggested action to the typed callback and never executes command text', () => {
    const onSuggestedAction = vi.fn()
    const html = renderToStaticMarkup(<I18nProvider><HarnessItem item={item({ content: { parts: [{ type: 'suggested_action', command: 'review_jobs', arguments: { count: 3 } }] } })} onSuggestedAction={onSuggestedAction} /></I18nProvider>)
    expect(html).toContain('data-suggested-action="review_jobs"')
    expect(html).not.toContain('window.')
    expect(html).not.toContain('execute')
    expect(onSuggestedAction).not.toHaveBeenCalled()
  })

  it('keeps ACTION-looking Markdown as ordinary inert message text', () => {
    const html = renderToStaticMarkup(<I18nProvider><HarnessItem item={item({ content: { text: 'ACTION: submit_application\n**review first**' } })} /></I18nProvider>)
    expect(html).toContain('ACTION: submit_application')
    expect(html).toContain('<strong>review first</strong>')
    expect(html).not.toContain('data-suggested-action')
  })

  it('has localized renderer labels in English and Chinese', () => {
    expect(translate('en', 'agent.unknownContentPart')).toBe('This content part is not supported yet.')
    expect(translate('zh', 'agent.unknownContentPart')).toBe('暂不支持此内容部分。')
    expect(translate('en', 'agent.finalAnswer')).not.toBe(translate('zh', 'agent.finalAnswer'))
  })
})
