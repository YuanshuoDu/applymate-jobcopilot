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

  it('renders completed direct and canonical subagent feedback ahead of generic output summaries', () => {
    const feedback = { disposition: 'failed', criteria: [{ criterionId: 'criterion-1', disposition: 'failed', reasonCode: 'does_not_meet_criterion', evidenceReferenceIds: ['private-reference'] }] }
    const output = { result: {
      status: 'completed', stepCount: 2, toolCallCount: 1, finalItemId: 'private-item', finalText: 'private final text',
      structuredResult: { schemaVersion: 'agent-harness.v2.subagent.result', role: 'analyst', status: 'completed', findings: [], evidence: [], summary: 'no findings' },
      nativeVerificationFeedback: feedback,
    } }
    const html = renderToStaticMarkup(<I18nProvider><HarnessItem item={item({ type: 'tool_result', status: 'completed', content: { toolName: 'agent.followup', outputSummary: 'clipped summary', output } })} /></I18nProvider>)
    expect(html).not.toContain('clipped summary')
    expect(html).toContain('data-native-verification-feedback="available"')
    expect(html).toContain('Evidence does not meet this check')
    expect(html).not.toContain('private-reference')
    expect(html).not.toContain('nativeVerificationFeedback')
    const start = html.indexOf('<section data-native-verification-feedback="available"')
    const card = html.slice(start, html.indexOf('</section>', start) + '</section>'.length)
    expect(card).not.toContain('private-item')
    expect(card).not.toContain('private final text')
  })

  it('renders bounded feedback from each agent.wait task result', () => {
    const html = renderToStaticMarkup(<I18nProvider><HarnessItem item={item({ type: 'tool_result', status: 'completed', content: { output: {
      status: 'ready', tasks: [
        { taskId: 'private-task-one', status: 'completed', result: { nativeVerificationFeedback: { disposition: 'passed', criteria: [{ criterionId: 'criterion-1', disposition: 'passed', reasonCode: 'meets_criterion', evidenceReferenceIds: ['private-ref-one'] }] } } },
        { taskId: 'private-task-two', status: 'completed', result: { nativeVerificationFeedback: { disposition: 'uncertain', criteria: [{ criterionId: 'criterion-1', disposition: 'uncertain', reasonCode: 'evidence_missing', evidenceReferenceIds: [] }] } } },
      ],
    } } })} /></I18nProvider>)
    expect(html).toContain('Check 1')
    expect(html).toContain('Passed')
    expect(html).toContain('Uncertain')
    expect(html).not.toContain('private-ref-one')
    const start = html.indexOf('<section data-native-verification-feedback="available"')
    const card = html.slice(start, html.indexOf('</section>', start) + '</section>'.length)
    expect(card).toContain('Result 1')
    expect(card).toContain('Result 2')
    expect(card.match(/Check 1/g)).toHaveLength(2)
    expect(card).not.toContain('private-task-one')
  })

  it('shows unavailable checks for malformed recognized feedback without serializing the slot', () => {
    const html = renderToStaticMarkup(<I18nProvider><HarnessItem item={item({ type: 'tool_result', status: 'completed', content: { output: {
      summary: 'safe ordinary output', nativeVerificationFeedback: { disposition: 'failed', criteria: [{ privateMarker: 'PRIVATE_FEEDBACK_MARKER' }] },
      nativeVerificationReport: { privateReceipt: 'PRIVATE_REPORT_MARKER' },
    } } })} /></I18nProvider>)
    expect(html).toContain('Checks unavailable')
    expect(html).not.toContain('safe ordinary output')
    expect(html).not.toContain('PRIVATE_FEEDBACK_MARKER')
    expect(html).not.toContain('PRIVATE_REPORT_MARKER')
    expect(html).not.toContain('outputSummary')
  })

  it('preserves ordinary tool result summary priority when no feedback slot exists', () => {
    const html = renderToStaticMarkup(<I18nProvider><HarnessItem item={item({ type: 'tool_result', status: 'completed', content: {
      toolName: 'jobs.search', input: { query: 'Berlin' }, outputSummary: 'ordinary clipped summary', output: { ordinary: 'structured detail' },
    } })} /></I18nProvider>)
    expect(html).toContain('jobs.search')
    expect(html).toContain('Berlin')
    expect(html).toContain('ordinary clipped summary')
    expect(html).not.toContain('structured detail')
    expect(html).not.toContain('data-native-verification-feedback')
  })

  it('preserves ordinary primitive and array result values without a feedback slot', () => {
    for (const result of ['existing child summary', ['ordinary', 'child', 'values']]) {
      const html = renderToStaticMarkup(<I18nProvider><HarnessItem item={item({ type: 'tool_result', status: 'completed', content: { result } })} /></I18nProvider>)
      if (typeof result === 'string') expect(html).toContain(result)
      else expect(html).toContain('child')
      expect(html).not.toContain('data-native-verification-feedback')
    }
  })

  it('preserves ordinary wait child values beside recognized feedback', () => {
    const html = renderToStaticMarkup(<I18nProvider><HarnessItem item={item({ type: 'tool_result', status: 'completed', content: { output: {
      status: 'ready', tasks: [
        { result: { nativeVerificationFeedback: { disposition: 'passed', criteria: [{ criterionId: 'criterion-1', disposition: 'passed', reasonCode: 'meets_criterion', evidenceReferenceIds: [] }] } } },
        { result: 'ordinary child summary' }, { result: ['ordinary', 'array child'] },
      ],
    } } })} /></I18nProvider>)
    expect(html).toContain('Result checks')
    expect(html).toContain('ordinary child summary')
    expect(html).toContain('ordinary')
    expect(html).toContain('array child')
  })

  it('does not render feedback cards for unfinished tool results or tool calls', () => {
    const output = { nativeVerificationFeedback: { disposition: 'passed', criteria: [{ criterionId: 'criterion-1', disposition: 'passed', reasonCode: 'meets_criterion', evidenceReferenceIds: [] }] } }
    for (const candidate of [item({ type: 'tool_result', status: 'running', content: { output } }), item({ type: 'tool_call', status: 'completed', content: { output } })]) {
      const html = renderToStaticMarkup(<I18nProvider><HarnessItem item={candidate} /></I18nProvider>)
      expect(html).not.toContain('data-native-verification-feedback')
    }
  })

  it('keeps unfinished recognized feedback out of generic output without hiding its ordinary siblings', () => {
    const validHtml = renderToStaticMarkup(<I18nProvider><HarnessItem item={item({ type: 'tool_result', status: 'running', content: { output: {
      summary: 'ordinary sibling', nativeVerificationFeedback: { disposition: 'passed', criteria: [{ criterionId: 'criterion-1', disposition: 'passed', reasonCode: 'meets_criterion', evidenceReferenceIds: ['private-reference'] }] },
    } } })} /></I18nProvider>)
    expect(validHtml).toContain('ordinary sibling')
    expect(validHtml).not.toContain('private-reference')
    expect(validHtml).not.toContain('data-native-verification-feedback')

    const privateHtml = renderToStaticMarkup(<I18nProvider><HarnessItem item={item({ type: 'tool_result', status: 'failed', content: {
      outputSummary: 'PRIVATE_REPORT_MARKER', output: { nativeVerificationReport: { privateReceipt: 'PRIVATE_REPORT_MARKER' } },
    } })} /></I18nProvider>)
    expect(privateHtml).not.toContain('PRIVATE_REPORT_MARKER')
    expect(privateHtml).not.toContain('data-native-verification-feedback')
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

  it('hides suggested actions when the host has no command handler', () => {
    const html = renderToStaticMarkup(<I18nProvider><HarnessItem item={item({ content: { parts: [{ type: 'suggested_action', command: 'review_jobs', arguments: null }] } })} /></I18nProvider>)
    expect(html).not.toContain('data-suggested-action')
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
