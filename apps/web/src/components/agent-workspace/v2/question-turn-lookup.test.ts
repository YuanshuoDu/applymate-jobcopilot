import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { I18nProvider, translate } from '@/lib/i18n'

import { AgentQuestionInputCard } from './AgentQuestionInputCard'
import { includeCurrentQuestionTurn } from './question-turn-lookup'
import type { TimelineItem } from './timeline-reducer'
import type { SupervisorTurnSummary } from './task-tree-projection'

const sessionId = 'session-current'
const activeProjection = { activeTurnId: 'turn-current', activeTurn: { id: 'turn-current', status: 'waiting_for_user', revision: 12 } }

function turn(id: string, revision = 1, owner = sessionId, status = 'in_progress'): SupervisorTurnSummary {
  return { id, sessionId: owner, source: 'user', goal: `Goal ${id}`, status, revision,
    activeStepId: null, finalItemId: null, createdAt: '', updatedAt: '', completedAt: null }
}

function question(turnId: string): TimelineItem {
  return { schemaVersion: 'agent-harness.v2', id: 'question-item', sessionId, turnId, stepId: null, taskId: null,
    type: 'question', status: 'started', phase: 'commentary', revision: 0,
    content: { waitKind: 'question', questionId: 'question-current', stage: 'profile', question: 'Choose an option?',
      options: [{ value: 'yes', label: 'Yes' }], pending: true, answerAvailable: false },
    startedAt: null, completedAt: null, createdAt: '', updatedAt: '', source: 'replay', sequence: '1' }
}

function card(turns: readonly SupervisorTurnSummary[], itemTurnId = 'turn-current'): string {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(AgentQuestionInputCard, {
    sessionId, items: [question(itemTurnId)], turns, onAccepted: () => undefined,
  })))
}

describe('includeCurrentQuestionTurn', () => {
  it('enables a question beyond the first 100 chronological Turns from the scoped active projection', () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => turn(`turn-${index}`))
    const lookup = includeCurrentQuestionTurn(firstPage, sessionId, activeProjection)

    expect(lookup).toHaveLength(1)
    expect(lookup.at(-1)).toMatchObject({ id: 'turn-current', sessionId, status: 'waiting_for_user', revision: 12 })
    const html = card(lookup)
    expect(html).not.toContain(translate('en', 'agent.question.turnUnavailable'))
    expect(html.match(/disabled=""/g)).toHaveLength(1)
  })

  it('uses the current projected revision for stale duplicate rows without adding a second Turn', () => {
    const lookup = includeCurrentQuestionTurn([turn('turn-current', 3, sessionId, 'waiting_for_user'), turn('turn-current', 4, sessionId, 'waiting_for_user'), turn('turn-other', 1, sessionId, 'waiting_for_user')], sessionId,
      { activeTurnId: 'turn-current', activeTurn: { id: 'turn-current', status: 'waiting_for_user', revision: 9 } })

    expect(lookup.filter(value => value.sessionId === sessionId && value.id === 'turn-current')).toHaveLength(1)
    expect(lookup.find(value => value.id === 'turn-current')).toMatchObject({ revision: 9, status: 'waiting_for_user' })
    expect(lookup).toHaveLength(2)
  })

  it('suppresses a stale waiting revision when the current matching Turn is active but not waiting for a user', () => {
    const lookup = includeCurrentQuestionTurn([turn('turn-current', 8, sessionId, 'waiting_for_user')], sessionId,
      { activeTurnId: 'turn-current', activeTurn: { id: 'turn-current', status: 'in_progress', revision: 9 } })

    expect(lookup).toHaveLength(0)
    expect(card(lookup)).toContain(translate('en', 'agent.question.turnUnavailable'))
  })

  it('fails closed for missing, malformed, foreign, or non-active projections', () => {
    const malformed = [
      null,
      {},
      { activeTurnId: 'turn-current', activeTurn: { id: '', status: 'waiting_for_user', revision: 12 } },
      { activeTurnId: 'turn-current', activeTurn: { id: 'turn-other', status: 'waiting_for_user', revision: 12 } },
      { activeTurnId: 'turn-current', activeTurn: { id: 'turn-current', sessionId: 'session-foreign', status: 'waiting_for_user', revision: 12 } },
      ...[-1, 1.5, '12', 2_147_483_648].map(revision => ({ activeTurnId: 'turn-current', activeTurn: { id: 'turn-current', status: 'waiting_for_user', revision } })),
      { activeTurnId: 'turn-current', activeTurn: { id: 'turn-current', status: 'completed', revision: 12 } },
    ]

    for (const projection of malformed) {
      const lookup = includeCurrentQuestionTurn([], sessionId, projection)
      expect(lookup).toHaveLength(0)
      expect(card(lookup)).toContain(translate('en', 'agent.question.turnUnavailable'))
    }
  })

  it('does not rebind a pending historical question to a different active Turn', () => {
    const lookup = includeCurrentQuestionTurn([], sessionId, activeProjection)
    const html = card(lookup, 'turn-historical')

    expect(lookup.some(value => value.id === 'turn-historical')).toBe(false)
    expect(html).toContain(translate('en', 'agent.question.turnUnavailable'))
    expect(html.match(/disabled=""/g)).toHaveLength(2)
  })
})
