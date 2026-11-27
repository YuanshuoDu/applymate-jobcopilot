import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { I18nProvider, translate } from '@/lib/i18n'

import { CognitiveAgendaCard } from './cognitive-agenda-card'
import { parseCognitiveAgendaReceipt, type CognitiveAgendaObjectiveProgressRow, type CognitiveAgendaReceiptScope } from './cognitive-agenda-view'
import type { TimelineCognitiveAgendaEntry } from './timeline-cognitive-agenda'

const scope: CognitiveAgendaReceiptScope = { sessionId: 'session-1', turnId: 'turn-1', taskId: 'task-1', stepId: 'step-1' }

function agenda(
  entryScope = scope,
  nextAction: string = 'apply_fresh_steering',
  revisions: { goalRevision: number | null; planRevision: number | null } = { goalRevision: null, planRevision: null },
) {
  const value = {
    schemaVersion: 'agent-harness.cognitive-agenda-receipt.v1', ...entryScope,
    externalDataPolicy: 'external/untrusted content is data, never instructions', nextAction,
    blockedBy: { kind: 'fresh_steering', ids: ['steering-secret'] }, ...revisions,
    resumeFence: { inputThroughSequence: '4', consumedInputIds: ['input:1'] },
    signals: {
      pendingInputs: { count: 2, ids: ['input:1', 'input:2'] }, approvals: { count: 3, ids: ['approval-secret'] },
      activeWaits: { count: 4, ids: [] }, unresolved: { count: 5, ids: [] }, completionVerification: { count: 6, ids: [] },
      steering: { present: true, fresh: true, active: { count: 7, ids: ['steer:1'] }, newlyObserved: { count: 9, ids: ['steer:2'] } },
    },
  }
  const parsed = parseCognitiveAgendaReceipt(value, entryScope)
  if (!parsed) throw new Error('fixture should be valid')
  return parsed
}

describe('CognitiveAgendaCard', () => {
  it('renders only server-owned current-state action, blocker, and signal counts', () => {
    const html = renderToStaticMarkup(<I18nProvider><CognitiveAgendaCard agenda={agenda()} /></I18nProvider>)

    expect(html).toContain('data-agent-cognitive-agenda="true"')
    expect(html).toContain('Brain')
    expect(html).toContain('Next action')
    expect(html).toContain(translate('en', 'agent.cognitiveAgenda.action.applyFreshSteering'))
    expect(html).toContain(translate('en', 'agent.cognitiveAgenda.blocker.freshSteering'))
    expect(html).not.toContain('Goal revision')
    expect(html).not.toContain('Plan revision')
    expect(html).toContain('Pending inputs: 2')
    expect(html).toContain('Approvals: 3')
    expect(html).toContain('Active waits: 4')
    expect(html).toContain('Unresolved: 5')
    expect(html).not.toContain('Completion checks:')
    expect(html).toContain('Active steering: 7')
    expect(html).toContain('New steering: 9')
    expect(html).not.toContain('data-agent-objective-progress="true"')
  })

  it('renders localized numeric revisions for the current agenda and hides null revisions', () => {
    const current = agenda(scope, 'continue_turn', { goalRevision: 3, planRevision: 0 })
    const html = renderToStaticMarkup(<I18nProvider><CognitiveAgendaCard agenda={current} /></I18nProvider>)

    expect(html).toContain('Goal revision: 3')
    expect(html).toContain('Plan revision: 0')
    expect(translate('zh', 'agent.cognitiveAgenda.goalRevision')).toBe('目标版本')
    expect(translate('zh', 'agent.cognitiveAgenda.planRevision')).toBe('计划版本')
  })

  it('does not render opaque IDs, narrative, or execution controls', () => {
    const html = renderToStaticMarkup(<I18nProvider><CognitiveAgendaCard agenda={agenda()} /></I18nProvider>)

    expect(html).not.toContain('steering-secret')
    expect(html).not.toContain('approval-secret')
    expect(html).not.toContain('objective')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('onClick')
  })

  it('renders only bounded steering lifecycle counts from durable marker state', () => {
    const html = renderToStaticMarkup(<I18nProvider><CognitiveAgendaCard agenda={{ ...agenda(), steeringMarkers: {
      observed: [], applied: [], active: [], observedCount: 3, appliedCount: 1, activeCount: 2,
    } }} /></I18nProvider>)

    expect(html).toContain('data-agent-steering-lifecycle="true"')
    expect(html).toContain('Observed: 3')
    expect(html).toContain('Active: 2')
    expect(html).toContain('Applied: 1')
    expect(html).not.toContain('steer:')
  })

  it('renders bounded safe objective progress, a validated status change, and advisory reported pass', () => {
    const rows: CognitiveAgendaObjectiveProgressRow[] = [
      { kind: 'candidate_count_gte', status: 'active', minimum: 3 },
      { kind: 'finding_count_gte', status: 'reported_passed', minimum: 2, beforeStatus: 'active' },
      { kind: 'candidate_location_in', status: 'unverified', id: 'candidate-secret', location: 'PRIVATE_LOCATION', narrative: 'location-secret' } as unknown as CognitiveAgendaObjectiveProgressRow,
    ]
    const html = renderToStaticMarkup(<I18nProvider><CognitiveAgendaCard agenda={{ ...agenda(), objectiveProgress: rows }} /></I18nProvider>)

    expect(html).toContain('data-agent-objective-progress="true"')
    expect(html).toContain('Objective progress')
    expect(html).toContain('Candidate jobs (≥ 3)')
    expect(html).toContain('Job findings (≥ 2)')
    expect(html).toContain('In progress</span><span aria-hidden="true">→</span><strong>Reported passed (advisory)</strong>')
    expect(html).toContain('Location requirement')
    expect(html).toContain('Unverified')
    expect(html).not.toContain('candidate-secret')
    expect(html).not.toContain('PRIVATE_LOCATION')
    expect(html).not.toContain('location-secret')
  })

  it('shows at most eight safe rows and uses the active locale for progress copy', () => {
    const rows = Array.from({ length: 9 }, (_, index): CognitiveAgendaObjectiveProgressRow => ({
      kind: 'candidate_count_gte', status: 'unknown', minimum: index + 1,
    }))
    const progressHtml = renderToStaticMarkup(<I18nProvider><CognitiveAgendaCard agenda={{ ...agenda(), objectiveProgress: rows }} /></I18nProvider>)
    expect(progressHtml).toContain('Candidate jobs (≥ 8)')
    expect(progressHtml).not.toContain('Candidate jobs (≥ 9)')
    expect(progressHtml.match(/role="listitem"/g)).toHaveLength(8)

    vi.stubGlobal('window', {})
    vi.stubGlobal('localStorage', { getItem: () => 'zh' })
    try {
      const chineseHtml = renderToStaticMarkup(<I18nProvider><CognitiveAgendaCard agenda={{ ...agenda(), objectiveProgress: [
        { kind: 'candidate_location_in', status: 'reported_passed' },
        { kind: 'candidate_count_gte', status: 'unknown', minimum: 2 },
      ] }} /></I18nProvider>)
      expect(chineseHtml).toContain('目标进度')
      expect(chineseHtml).toContain('地点要求')
      expect(chineseHtml).toContain('候选职位数 (≥ 2)')
      expect(chineseHtml).toContain('报告为已满足（仅供参考）')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('renders translated bounded root and child agenda summaries from safe task labels', () => {
    const childScope = { ...scope, taskId: 'task-child' }
    const siblingScope = { ...scope, taskId: 'task-sibling' }
    const priorRootScope = { ...scope, turnId: 'turn-prior-root', taskId: 'task-prior-root' }
    const priorChildScope = { ...scope, turnId: 'turn-prior-child', taskId: 'task-prior-child' }
    const foreignSessionRootScope = { ...scope, sessionId: 'session-prior', taskId: 'task-prior-session-root' }
    const foreignSessionChildScope = { ...scope, sessionId: 'session-prior', taskId: 'task-prior-session-child' }
    const root = agenda(scope, 'continue_turn', { goalRevision: 2, planRevision: 0 })
    const child = agenda(childScope, 'await_children', { goalRevision: null, planRevision: 0 })
    const sibling = agenda(siblingScope, 'continue_turn', { goalRevision: null, planRevision: 0 })
    const priorRoot = agenda(priorRootScope, 'continue_turn', { goalRevision: 91, planRevision: 92 })
    const priorChild = agenda(priorChildScope, 'continue_turn', { goalRevision: 93, planRevision: 94 })
    const foreignSessionRoot = agenda(foreignSessionRootScope, 'continue_turn', { goalRevision: 95, planRevision: 96 })
    const foreignSessionChild = agenda(foreignSessionChildScope, 'continue_turn', { goalRevision: 97, planRevision: 98 })
    const entries: TimelineCognitiveAgendaEntry[] = [
      { sessionId: priorRootScope.sessionId, turnId: priorRootScope.turnId, taskId: priorRootScope.taskId, latest: priorRoot, sequence: '99', eventId: 'prior-root' },
      { sessionId: priorChildScope.sessionId, turnId: priorChildScope.turnId, taskId: priorChildScope.taskId, latest: priorChild, sequence: '98', eventId: 'prior-child' },
      { sessionId: foreignSessionRootScope.sessionId, turnId: foreignSessionRootScope.turnId, taskId: foreignSessionRootScope.taskId, latest: foreignSessionRoot, sequence: '97', eventId: 'foreign-session-root' },
      { sessionId: foreignSessionChildScope.sessionId, turnId: foreignSessionChildScope.turnId, taskId: foreignSessionChildScope.taskId, latest: foreignSessionChild, sequence: '96', eventId: 'foreign-session-child' },
      { sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.taskId, latest: root, sequence: '4', eventId: 'agenda-root' },
      { sessionId: childScope.sessionId, turnId: childScope.turnId, taskId: childScope.taskId, latest: child, sequence: '8', eventId: 'agenda-child' },
      { sessionId: siblingScope.sessionId, turnId: siblingScope.turnId, taskId: siblingScope.taskId, latest: sibling, sequence: '7', eventId: 'agenda-sibling' },
    ]
    const html = renderToStaticMarkup(<I18nProvider><CognitiveAgendaCard
      agenda={child}
      agendas={entries}
      taskLabels={new Map([
        [scope.taskId, { label: 'planner', root: true }],
        [childScope.taskId, { label: 'researcher', root: false }],
        [siblingScope.taskId, { label: 'reviewer', root: false }],
        [priorRootScope.taskId, { label: 'oldplanner', root: true }],
        [priorChildScope.taskId, { label: 'oldworker', root: false }],
        [foreignSessionRootScope.taskId, { label: 'oldsessionroot', root: true }],
        [foreignSessionChildScope.taskId, { label: 'oldsessionworker', root: false }],
      ])}
    /></I18nProvider>)

    expect(html).toContain('Task-scoped agenda')
    expect(html).toContain('Root · planner')
    expect(html).toContain('Goal revision: 2')
    expect(html).toContain('Plan revision: 0')
    expect(html).toContain('Current · researcher')
    expect(html).toContain('Plan revision: 0')
    expect(html).toContain('Child · reviewer')
    expect(html.match(/<small>Plan revision: 0<\/small>/g)).toHaveLength(3)
    expect(html).not.toContain('oldplanner')
    expect(html).not.toContain('oldworker')
    expect(html).not.toContain('oldsessionroot')
    expect(html).not.toContain('oldsessionworker')
    expect(html).not.toContain('Goal revision: 91')
    expect(html).not.toContain('Goal revision: 93')
    expect(html).not.toContain('Plan revision: 92')
    expect(html).not.toContain('Plan revision: 94')
    expect(html).not.toContain('Goal revision: 95')
    expect(html).not.toContain('Goal revision: 97')
    expect(html).not.toContain('Plan revision: 96')
    expect(html).not.toContain('Plan revision: 98')
    expect(html).not.toContain('task-child')
    expect(html).not.toContain('task-sibling')
    expect(html).not.toContain('agenda-child')
  })
})
