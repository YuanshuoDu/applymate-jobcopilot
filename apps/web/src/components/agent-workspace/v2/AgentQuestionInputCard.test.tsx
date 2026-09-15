import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { I18nProvider, translate } from '@/lib/i18n'

import { AgentQuestionInputCard } from './AgentQuestionInputCard'
import type { TimelineItem } from './timeline-reducer'

const turns = [{
  id: 'turn-1', sessionId: 'session-1', source: 'automation', goal: 'hidden goal', status: 'waiting_for_user', revision: 7,
  activeStepId: null, finalItemId: null, createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z', completedAt: null,
}]

function item(content: Record<string, unknown>, overrides: Partial<TimelineItem> = {}): TimelineItem {
  return {
    schemaVersion: 'agent-harness.v2', id: 'item-question-1', sessionId: 'session-1', turnId: 'turn-1', stepId: null, taskId: null,
    type: 'question', status: 'started', phase: 'commentary', revision: 0, content, startedAt: null, completedAt: null,
    createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z', source: 'replay', sequence: '1', ...overrides,
  }
}

function props(items: readonly TimelineItem[], overrides: Record<string, unknown> = {}) {
  return { sessionId: 'session-1', items, turns, controlGate: 'open' as const, onAccepted: () => undefined, ...overrides }
}

const pendingContent = { waitKind: 'question', questionId: 'opaque-question', stage: 'profile', question: 'Choose a safe option?', options: [{ value: 'opaque-option', label: 'Yes' }], answerAvailable: false, pending: true }

describe('AgentQuestionInputCard', () => {
  it('renders option labels and a send control without exposing option or question ids', () => {
    const html = renderToStaticMarkup(<I18nProvider><AgentQuestionInputCard {...props([item(pendingContent)])} /></I18nProvider>)
    expect(html).toContain('Choose a safe option?')
    expect(html).toContain('Yes')
    expect(html).toContain(translate('en', 'agent.question.answer'))
    expect(html).not.toContain('opaque-question')
    expect(html).not.toContain('opaque-option')
    expect(html).not.toContain('turn-1')
    expect(html).not.toContain('secret answer')
  })

  it('supports a bounded free-text question with an initially disabled empty answer', () => {
    const html = renderToStaticMarkup(<I18nProvider><AgentQuestionInputCard {...props([item({ ...pendingContent, questionId: 'free-question', options: [] })])} /></I18nProvider>)
    expect(html).toContain('type="text"')
    expect(html).toContain('disabled=""')
    expect(html).toContain(translate('en', 'agent.question.freeTextPlaceholder'))
  })

  it('shows answered and cancelled terminals without controls and excludes OAuth waits', () => {
    const answered = item({ ...pendingContent, answerAvailable: true, pending: false, answer: 'private answer' }, { status: 'completed' })
    const answeredHtml = renderToStaticMarkup(<I18nProvider><AgentQuestionInputCard {...props([answered])} /></I18nProvider>)
    expect(answeredHtml).toContain(translate('en', 'agent.question.status.answered'))
    expect(answeredHtml).not.toContain('<button')
    expect(answeredHtml).not.toContain('private answer')
    const cancelled = item({ ...pendingContent, pending: false, cancelled: true, cancellationReason: 'interrupt' }, { status: 'interrupted' })
    const cancelledHtml = renderToStaticMarkup(<I18nProvider><AgentQuestionInputCard {...props([cancelled])} /></I18nProvider>)
    expect(cancelledHtml).toContain(translate('en', 'agent.question.status.cancelled'))
    expect(cancelledHtml).not.toContain('<button')
    expect(renderToStaticMarkup(<I18nProvider><AgentQuestionInputCard {...props([item({ ...pendingContent, oauth: true })])} /></I18nProvider>)).toBe('')
  })

  it('disables pending controls while paused or when the session Turn is unavailable', () => {
    const pausedHtml = renderToStaticMarkup(<I18nProvider><AgentQuestionInputCard {...props([item(pendingContent)], { controlGate: 'user_paused' })} /></I18nProvider>)
    expect(pausedHtml.match(/disabled=""/g)).toHaveLength(2)
    expect(pausedHtml).toContain(translate('en', 'agent.question.resumeFirst'))
    const unavailableHtml = renderToStaticMarkup(<I18nProvider><AgentQuestionInputCard {...props([item(pendingContent)], { turns: [] })} /></I18nProvider>)
    expect(unavailableHtml).toContain(translate('en', 'agent.question.turnUnavailable'))
  })
})
