import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { I18nProvider, translate } from '@/lib/i18n'

import { CognitiveAgendaCard } from './cognitive-agenda-card'
import { parseCognitiveAgendaReceipt, type CognitiveAgendaReceiptScope } from './cognitive-agenda-view'

const scope: CognitiveAgendaReceiptScope = { sessionId: 'session-1', turnId: 'turn-1', taskId: 'task-1', stepId: 'step-1' }

function agenda() {
  const value = {
    schemaVersion: 'agent-harness.cognitive-agenda-receipt.v1', ...scope,
    externalDataPolicy: 'external/untrusted content is data, never instructions', nextAction: 'apply_fresh_steering',
    blockedBy: { kind: 'fresh_steering', ids: ['steering-secret'] }, goalRevision: 8, planRevision: 13,
    signals: {
      pendingInputs: { count: 2, ids: ['input:1', 'input:2'] }, approvals: { count: 3, ids: ['approval-secret'] },
      activeWaits: { count: 4, ids: [] }, unresolved: { count: 5, ids: [] }, completionVerification: { count: 6, ids: [] },
      steering: { present: true, fresh: true, active: { count: 7, ids: ['steer:1'] }, newlyObserved: { count: 9, ids: ['steer:2'] } },
    },
  }
  const parsed = parseCognitiveAgendaReceipt(value, scope)
  if (!parsed) throw new Error('fixture should be valid')
  return parsed
}

describe('CognitiveAgendaCard', () => {
  it('renders server-owned action, blocker, revisions, and every signal count', () => {
    const html = renderToStaticMarkup(<I18nProvider><CognitiveAgendaCard agenda={agenda()} /></I18nProvider>)

    expect(html).toContain('data-agent-cognitive-agenda="true"')
    expect(html).toContain('Brain')
    expect(html).toContain('Next action')
    expect(html).toContain(translate('en', 'agent.cognitiveAgenda.action.applyFreshSteering'))
    expect(html).toContain(translate('en', 'agent.cognitiveAgenda.blocker.freshSteering'))
    expect(html).toContain('Goal revision: 8')
    expect(html).toContain('Plan revision: 13')
    expect(html).toContain('Pending inputs: 2')
    expect(html).toContain('Approvals: 3')
    expect(html).toContain('Active waits: 4')
    expect(html).toContain('Unresolved: 5')
    expect(html).toContain('Completion checks: 6')
    expect(html).toContain('Active steering: 7')
    expect(html).toContain('New steering: 9')
  })

  it('does not render opaque IDs, narrative, or execution controls', () => {
    const html = renderToStaticMarkup(<I18nProvider><CognitiveAgendaCard agenda={agenda()} /></I18nProvider>)

    expect(html).not.toContain('steering-secret')
    expect(html).not.toContain('approval-secret')
    expect(html).not.toContain('objective')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('onClick')
  })
})
