import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/lib/i18n'
import { AgentLiveStreamBody, toHarnessItem } from './AgentLiveStreamBody'
import type { ApplyReadyJob } from './ApplyJobCard'
import type { AgentTranscriptEvent } from './session-view-model'

const auth = vi.hoisted(() => ({ userId: 'user-1' }))
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: auth.userId } }, status: 'authenticated' }),
}))

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

  it('explains that opening the employer link does not record a submission', () => {
    const job: ApplyReadyJob = {
      jobId: 'job-1', company: 'N26', role: 'Software Engineer', score: 90,
      url: 'https://example.test/apply', matchedKeywords: [],
    }
    const html = renderToStaticMarkup(<I18nProvider><AgentLiveStreamBody
      log={[]}
      liveBlocks={[]}
      applyQueue={[job]}
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

    expect(html).toContain('Apply now only opens the employer page. Record your application after you submit it there.')
    expect(html).toContain('I submitted — record application')
    expect(html).not.toContain('Click “Apply now” to confirm delivery')
  })

  it('does not consume another account’s reported status in the queue or card', () => {
    const job: ApplyReadyJob = {
      jobId: 'job-1', company: 'N26', role: 'Software Engineer', score: 90,
      url: 'https://example.test/apply', matchedKeywords: [],
      manualRecordStatuses: { 'user-a': 'reported' },
    }
    auth.userId = 'user-b'
    const otherAccountHtml = renderToStaticMarkup(<I18nProvider><AgentLiveStreamBody
      log={[]}
      liveBlocks={[]}
      applyQueue={[job]}
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
    auth.userId = 'user-a'
    const ownerHtml = renderToStaticMarkup(<I18nProvider><AgentLiveStreamBody
      log={[]}
      liveBlocks={[]}
      applyQueue={[job]}
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

    expect(otherAccountHtml).toContain('I submitted — record application')
    expect(otherAccountHtml).toContain('font-weight:600">1</span>')
    expect(ownerHtml).toContain('Recorded from your confirmation')
    expect(ownerHtml).toContain('font-weight:600">0</span>')
  })
})
