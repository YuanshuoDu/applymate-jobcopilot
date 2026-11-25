import React from 'react'
import { readFileSync } from 'node:fs'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentObjectiveContextForm,
  canSubmitObjectiveContext,
  isObjectiveDraftPending,
  objectiveContextFormReducer,
  type AgentObjectiveContextFormState,
} from './AgentObjectiveContextForm'

const source = readFileSync(new URL('./AgentObjectiveContextForm.tsx', import.meta.url), 'utf8')

const emptyState: AgentObjectiveContextFormState = {
  objective: '', context: '', allowedLocationsDraft: '', reportScoreFloorDraft: '', open: false, pending: false, accepted: false, error: null,
}

describe('AgentObjectiveContextForm', () => {
  it('offers an opt-in entry and does not render either draft field before opening', () => {
    const html = renderToString(<AgentObjectiveContextForm startLockRef={{ current: false }} onAccepted={vi.fn()} />)
    expect(html).toContain('Start with an objective and background')
    expect(html).not.toContain('objective-context-form')
    expect(html).not.toContain('agent-task-objective')
    expect(html).not.toContain('agent-task-background')
    expect(html).not.toContain('objective-context-report-score-floor')
  })

  it('renders no objective controls while a Session is selected', () => {
    const html = renderToString(<AgentObjectiveContextForm available={false} startLockRef={{ current: false }} onAccepted={vi.fn()} />)
    expect(html).toBe('')
    expect(source).toContain('const wasAvailableRef = useRef(available)')
    expect(source).toContain('const becameAvailable = available && !wasAvailableRef.current')
    expect(source).toContain('coordinatorRef.current?.discard()')
  })

  it('keeps ordinary chat gated until an open objective draft is accepted or discarded', () => {
    const open = objectiveContextFormReducer(emptyState, { type: 'open' })
    const failed = objectiveContextFormReducer(open, {
      type: 'failed', error: { message: 'Request outcome unknown', conflict: false },
    })
    const accepted = objectiveContextFormReducer(open, { type: 'accepted' })
    const discarded = objectiveContextFormReducer(open, { type: 'discard' })

    expect(isObjectiveDraftPending(open)).toBe(true)
    expect(isObjectiveDraftPending(failed)).toBe(true)
    expect(isObjectiveDraftPending(accepted)).toBe(false)
    expect(isObjectiveDraftPending(discarded)).toBe(false)
    expect(source).toContain('onDraftPendingChange?.(isObjectiveDraftPending(nextState))')
  })

  it('keeps objective and context as separate exact drafts through failure and allows explicit retry', () => {
    let state = objectiveContextFormReducer(emptyState, { type: 'open' })
    state = objectiveContextFormReducer(state, { type: 'edit-objective', value: '  Find senior roles  ' })
    state = objectiveContextFormReducer(state, { type: 'edit-context', value: '\nReference wording stays exact.\n' })
    state = objectiveContextFormReducer(state, { type: 'edit-allowed-locations', value: 'Dublin, Ireland\nBerlin' })
    state = objectiveContextFormReducer(state, { type: 'edit-score-floor', value: '4.25' })
    expect(canSubmitObjectiveContext(state)).toBe(true)
    const pending = objectiveContextFormReducer(state, { type: 'pending' })
    expect(canSubmitObjectiveContext(pending)).toBe(false)
    const failed = objectiveContextFormReducer(pending, {
      type: 'failed', error: { message: 'Session changed', conflict: true },
    })
    expect(failed).toMatchObject({
      open: true,
      objective: '  Find senior roles  ',
      context: '\nReference wording stays exact.\n',
      allowedLocationsDraft: 'Dublin, Ireland\nBerlin',
      reportScoreFloorDraft: '4.25',
      pending: false,
      error: { message: 'Session changed', conflict: true },
    })
    expect(canSubmitObjectiveContext(failed)).toBe(true)
  })

  it('keeps the optional report-only floor blank or explicitly within the decimal range', () => {
    const draft = { ...emptyState, open: true, objective: 'Find roles' }
    for (const value of ['', '0', '.25', '4.5', '10']) {
      expect(canSubmitObjectiveContext({ ...draft, reportScoreFloorDraft: value })).toBe(true)
    }
    for (const value of ['11', '-0.1', '1e2', 'bad', ' ']) {
      expect(canSubmitObjectiveContext({ ...draft, reportScoreFloorDraft: value })).toBe(false)
    }
  })

  it('clears only on accepted start or explicit discard and keeps accepted callback failure non-retryable', () => {
    const draft = {
      ...emptyState, open: true, objective: 'Objective', context: 'Background',
    }
    expect(objectiveContextFormReducer(draft, { type: 'accepted' })).toMatchObject({
      open: false, accepted: true, objective: '', context: '', reportScoreFloorDraft: '', pending: false,
    })
    expect(objectiveContextFormReducer(draft, { type: 'callback-failed', message: 'Navigation failed' })).toMatchObject({
      open: false, accepted: true, objective: '', context: '', reportScoreFloorDraft: '', error: { message: 'Navigation failed' },
    })
    expect(objectiveContextFormReducer(draft, { type: 'discard' })).toEqual(emptyState)
  })

  it('keeps the copy and interaction boundary explicit', () => {
    expect(source).toContain('The objective defines what must be complete. Background is reference material for the task.')
    expect(source).toContain('Allowed job locations (optional)')
    expect(source).toContain('Report score threshold (optional, report-only)')
    expect(source).toContain('Count jobs with a verified score at or above this threshold')
    expect(source).toContain('aria-invalid={invalidScoreFloor}')
    expect(source).toContain('aria-describedby="agent-task-report-score-floor-help"')
    expect(source).not.toContain('aria-label="Report score threshold')
    expect(source).toContain('type="text"')
    expect(source).toContain('inputMode="decimal"')
    expect(source).toContain('reportScoreFloorDraft: \'\'')
    expect(source).toContain('undefined, undefined, scoreFloor')
    expect(source).toContain('one location per line')
    expect(source).toContain('Dublin does not match Dublin, Ireland. Aliases are not inferred.')
    expect(source).toContain('Text is sent unchanged.')
    expect(source).toContain('error.conflict')
    expect(source).toContain('No existing run was changed; edit or retry explicitly.')
    expect(source).toContain('attachedFileCount > 0 || ordinaryComposerDraftPresent')
    expect(source).toContain('that content will not be sent or discarded here.')
    expect(source.match(/coordinatorRef\.current\?\.draftEdited\(\)/g)).toHaveLength(4)
    const acceptedAt = source.indexOf("dispatchAction({ type: 'accepted' })")
    const callbackAt = source.indexOf('onAccepted(result.sessionId, result.objective)')
    expect(acceptedAt).toBeGreaterThanOrEqual(0)
    expect(callbackAt).toBeGreaterThan(acceptedAt)
    expect(source).toContain('callback-failed')
    expect(source).not.toContain('attachedFiles')
    expect(source).not.toContain('sendAgentTurnMessage')
  })
})
