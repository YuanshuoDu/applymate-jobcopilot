import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { I18nProvider } from '@/lib/i18n'
import { HarnessTimeline, highlightedFinalItemIds } from './HarnessTimeline'
import type { TimelineItem } from './timeline-reducer'

function item(id: string, overrides: Partial<TimelineItem> = {}): TimelineItem {
  return {
    schemaVersion: 'agent-harness.v2', id, sessionId: 'session-1', turnId: 'turn-1', stepId: null, taskId: null,
    type: 'agent_message', status: 'completed', phase: 'commentary', revision: 1, content: { text: id }, startedAt: null, completedAt: null,
    createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z', source: 'replay', sequence: null, ...overrides,
  }
}

describe('HarnessTimeline', () => {
  it('highlights exactly one final answer per Turn, choosing the latest revision', () => {
    const items = [item('commentary'), item('final-old', { phase: 'final_answer', updatedAt: '2026-09-03T00:00:01.000Z' }), item('final-new', { phase: 'final_answer', updatedAt: '2026-09-03T00:00:02.000Z' })]
    expect(highlightedFinalItemIds(items)).toEqual(new Set(['final-new']))
    const html = renderToStaticMarkup(<I18nProvider><HarnessTimeline items={items} /></I18nProvider>)
    expect((html.match(/data-agent-final="true"/g) ?? []).length).toBe(1)
  })

  it('keeps separate Turns in the timeline projection', () => {
    const html = renderToStaticMarkup(<I18nProvider><HarnessTimeline items={[item('one', { phase: 'final_answer' }), item('two', { turnId: 'turn-2', phase: 'final_answer' })]} /></I18nProvider>)
    expect((html.match(/data-agent-turn-id=/g) ?? []).length).toBe(2)
    expect((html.match(/data-agent-final="true"/g) ?? []).length).toBe(2)
  })
})
