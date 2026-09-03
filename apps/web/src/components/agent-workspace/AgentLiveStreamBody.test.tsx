import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { I18nProvider } from '@/lib/i18n'
import { AgentLiveStreamBody, toHarnessItem } from './AgentLiveStreamBody'
import type { AgentTranscriptEvent } from './session-view-model'

const event: AgentTranscriptEvent = {
  id: 'event-1', taskId: null, type: 'agent_message', speaker: 'Orchestrator', title: null, body: '', data: {
    item: {
      schemaVersion: 'agent-harness.v2', id: 'item-1', sessionId: 'session-1', turnId: 'turn-1', stepId: null,
      type: 'agent_message', status: 'completed', phase: 'final_answer', revision: 1,
      content: { parts: [{ type: 'text', text: '**Done**' }] }, startedAt: null, completedAt: null,
      createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z',
    },
  }, durationMs: null, createdAt: '2026-09-03T00:00:00.000Z',
}

describe('AgentLiveStreamBody Harness bridge', () => {
  it('adopts valid V2 items and leaves legacy payloads on the old renderer', () => {
    expect(toHarnessItem(event)).toMatchObject({ id: 'item-1', phase: 'final_answer' })
    expect(toHarnessItem({ ...event, data: { html: '<script>attack</script>' } })).toBeNull()
  })

  it('renders a V2 final item through the typed renderer without an execution handler', () => {
    const html = renderToStaticMarkup(<I18nProvider><AgentLiveStreamBody
      log={[]}
      liveBlocks={[event]}
      applyQueue={[]}
      isEmpty={false}
      isRestoringSession={false}
      revealThinkingVersion={0}
      streamScrollRef={{ current: null }}
      streamEndRef={{ current: null }}
      onAnswerQuestion={() => undefined}
      onAnswerOrchestrator={() => undefined}
      onApplied={() => undefined}
      onLiveBlockAction={() => undefined}
      onFollowStateChange={() => undefined}
    /></I18nProvider>)
    expect(html).toContain('data-agent-final="true"')
    expect(html).toContain('<strong>Done</strong>')
    expect(html).not.toContain('dangerouslySetInnerHTML')
  })
})
