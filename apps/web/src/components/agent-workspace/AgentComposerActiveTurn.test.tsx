import React from 'react'
import { readFileSync } from 'node:fs'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  acquireObjectiveReplacementRequest,
  AgentComposerActiveTurn,
  canSubmitObjectiveReplacement,
  objectiveReplacementFormReducer,
  type ObjectiveReplacementFormState,
} from './AgentComposerActiveTurn'
import type { TurnComposerController } from './agent-turn-commands'

const componentSource = readFileSync(new URL('./AgentComposerActiveTurn.tsx', import.meta.url), 'utf8')

describe('AgentComposerActiveTurn', () => {
  it('shows delivery choices, all command states, and the interrupt affordance', () => {
    const controller: TurnComposerController = {
      sessionId: 'session_1', activeTurn: { id: 'turn_1', status: 'in_progress', revision: 2 }, sessionStatus: 'running', refresh: vi.fn(), delivery: 'steer',
      setDelivery: vi.fn(), chatInput: '', setChatInput: vi.fn(), sending: false,
      messages: [
        { clientMessageId: 'sending', text: 'One', delivery: 'steer', status: 'sending' },
        { clientMessageId: 'accepted', text: 'Two', delivery: 'follow_up', status: 'accepted' },
        { clientMessageId: 'consumed', text: 'Three', delivery: 'steer', status: 'consumed' },
        { clientMessageId: 'failed', text: 'Four', delivery: 'steer', status: 'failed' },
      ],
      commandError: null, send: vi.fn(), interrupt: vi.fn(), interrupting: false,
    }
    const html = renderToString(<AgentComposerActiveTurn controller={controller} />)

    expect(html).toContain('Steer current Turn')
    expect(html).toContain('Queue follow-up')
    expect(html).toContain('data-testid="interrupt-turn"')
    expect(html).toContain('Sending')
    expect(html).toContain('Accepted')
    expect(html).toContain('Consumed')
    expect(html).toContain('Failed')
    expect(html).toContain('Replace objective')
    expect(html).not.toContain('objective-replacement-form')
  })

  it('only opens replacement for a running Session with an active Turn', () => {
    const controller: TurnComposerController = {
      sessionId: 'session_1', activeTurn: { id: 'turn_1', status: 'in_progress', revision: 2 }, sessionStatus: 'paused', delivery: 'steer',
      setDelivery: vi.fn(), chatInput: '', setChatInput: vi.fn(), sending: false, messages: [], commandError: null,
      send: vi.fn(), interrupt: vi.fn(), interrupting: false,
    }
    expect(renderToString(<AgentComposerActiveTurn controller={controller} />)).not.toContain('open-objective-replacement')
    expect(renderToString(<AgentComposerActiveTurn controller={{ ...controller, sessionStatus: 'running', activeTurn: null }} />)).not.toContain('open-objective-replacement')
  })

  it('keeps the captured target and request identity through conflict and uncertain retry', () => {
    const initial: ObjectiveReplacementFormState = {
      open: false, target: null, draft: '', clientMessageId: null, pending: false, error: null,
    }
    const opened = objectiveReplacementFormReducer(initial, {
      type: 'open', target: { turnId: 'turn_1', revision: 2 }, clientMessageId: 'request_1',
    })
    const edited = objectiveReplacementFormReducer(opened, { type: 'edit', draft: 'New goal', clientMessageId: 'request_2' })
    expect(canSubmitObjectiveReplacement(opened)).toBe(false)
    expect(canSubmitObjectiveReplacement(edited)).toBe(true)
    const lock = { current: false }
    expect(acquireObjectiveReplacementRequest(lock, edited)).toBe(true)
    expect(acquireObjectiveReplacementRequest(lock, edited)).toBe(false)
    expect(objectiveReplacementFormReducer(edited, { type: 'edit', draft: 'New goal', clientMessageId: 'unused' })).toBe(edited)
    const conflicted = objectiveReplacementFormReducer(
      objectiveReplacementFormReducer(edited, { type: 'pending' }),
      { type: 'failed', error: { message: 'Turn changed', conflict: true } },
    )

    expect(conflicted).toMatchObject({ open: true, target: { turnId: 'turn_1', revision: 2 }, draft: 'New goal', clientMessageId: 'request_2', pending: false, error: { conflict: true } })
    const retry = objectiveReplacementFormReducer(conflicted, { type: 'pending' })
    expect(retry.clientMessageId).toBe('request_2')
    const uncertain = objectiveReplacementFormReducer(retry, { type: 'failed', error: { message: 'Network outcome unknown', conflict: false } })
    expect(uncertain).toMatchObject({ target: { turnId: 'turn_1', revision: 2 }, draft: 'New goal', clientMessageId: 'request_2' })
    const changed = objectiveReplacementFormReducer(conflicted, { type: 'edit', draft: 'Another goal', clientMessageId: 'request_3' })
    expect(changed).toMatchObject({ target: { turnId: 'turn_1', revision: 2 }, draft: 'Another goal', clientMessageId: 'request_3', error: null })
    const closed = objectiveReplacementFormReducer(changed, { type: 'discard' })
    const reopened = objectiveReplacementFormReducer(closed, { type: 'open', target: { turnId: 'turn_2', revision: 7 }, clientMessageId: 'request_4' })
    expect(reopened).toMatchObject({ open: true, target: { turnId: 'turn_2', revision: 7 }, draft: '', clientMessageId: 'request_4' })
    expect(objectiveReplacementFormReducer(reopened, { type: 'success' })).toMatchObject({ open: false, target: null, draft: '', clientMessageId: null })
  })

  it('submits only the captured target through the replacement helper and refreshes on acceptance', () => {
    const requestStart = componentSource.indexOf('void replaceAgentObjective({')
    const requestEnd = componentSource.indexOf('}).then(() => {', requestStart)
    const acceptedEnd = componentSource.indexOf('}).catch((reason: unknown) => {', requestEnd)
    const request = componentSource.slice(requestStart, requestEnd)
    const accepted = componentSource.slice(requestEnd, acceptedEnd)

    expect(request).toContain('expectedTurnId: replacement.target.turnId')
    expect(request).toContain('expectedRevision: replacement.target.revision')
    expect(request).not.toContain('controller.activeTurn.id')
    expect(accepted).toContain("dispatch({ type: 'success' })")
    expect(accepted).toContain('controller.refresh?.()')
    expect(componentSource).toContain('Write a short objective; send detailed context separately.')
    expect(componentSource).not.toContain('maxLength=')
    expect(componentSource).toContain('<ActiveTurnSession key={controller.sessionId}')
    expect(componentSource).not.toContain('controller.send(')
  })
})
