'use client'

import React, { useReducer, useRef, type FormEvent } from 'react'
import { ObjectiveReplacementCommandError, replaceAgentObjective } from './agent-objective-replacement-command'
import type { TurnComposerController } from './agent-turn-commands'

const composerStatusLabel = {
  sending: 'Sending',
  accepted: 'Accepted',
  consumed: 'Consumed',
  failed: 'Failed',
} as const

export interface ObjectiveReplacementFormState {
  open: boolean
  target: { turnId: string; revision: number } | null
  draft: string
  clientMessageId: string | null
  pending: boolean
  error: { message: string; conflict: boolean } | null
}

type ObjectiveReplacementAction =
  | { type: 'open'; target: { turnId: string; revision: number }; clientMessageId: string }
  | { type: 'edit'; draft: string; clientMessageId: string }
  | { type: 'pending' }
  | { type: 'failed'; error: { message: string; conflict: boolean } }
  | { type: 'success' }
  | { type: 'discard' }

const initialReplacementState: ObjectiveReplacementFormState = {
  open: false, target: null, draft: '', clientMessageId: null, pending: false, error: null,
}

export function objectiveReplacementFormReducer(
  state: ObjectiveReplacementFormState,
  action: ObjectiveReplacementAction,
): ObjectiveReplacementFormState {
  if (action.type === 'open') {
    return { open: true, target: action.target, draft: '', clientMessageId: action.clientMessageId, pending: false, error: null }
  }
  if (action.type === 'edit') {
    return action.draft === state.draft ? state : { ...state, draft: action.draft, clientMessageId: action.clientMessageId, error: null }
  }
  if (action.type === 'pending') return { ...state, pending: true, error: null }
  if (action.type === 'failed') return { ...state, pending: false, error: action.error }
  return initialReplacementState
}

export function canSubmitObjectiveReplacement(state: ObjectiveReplacementFormState): boolean {
  return state.open && state.target !== null && state.clientMessageId !== null && !state.pending && Boolean(state.draft.trim())
}

export function acquireObjectiveReplacementRequest(lock: { current: boolean }, state: ObjectiveReplacementFormState): boolean {
  if (lock.current || !canSubmitObjectiveReplacement(state)) return false
  lock.current = true
  return true
}

export function AgentComposerActiveTurn({ controller }: { controller: TurnComposerController }) {
  return <ActiveTurnSession key={controller.sessionId} controller={controller} />
}

function ActiveTurnSession({ controller }: { controller: TurnComposerController }) {
  const [replacement, dispatch] = useReducer(objectiveReplacementFormReducer, initialReplacementState)
  const pendingRef = useRef(false)
  const canOpenReplacement = controller.sessionStatus === 'running' && controller.activeTurn !== null
  const targetChanged = replacement.target !== null && (
    controller.sessionStatus !== 'running'
    || controller.activeTurn?.id !== replacement.target.turnId
    || controller.activeTurn?.revision !== replacement.target.revision
  )

  const openReplacement = () => {
    if (!canOpenReplacement || !controller.activeTurn) return
    dispatch({
      type: 'open',
      target: { turnId: controller.activeTurn.id, revision: controller.activeTurn.revision },
      clientMessageId: newClientMessageId(),
    })
  }

  const submitReplacement = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!acquireObjectiveReplacementRequest(pendingRef, replacement) || !replacement.target || !replacement.clientMessageId) return
    dispatch({ type: 'pending' })
    void replaceAgentObjective({
      sessionId: controller.sessionId,
      expectedTurnId: replacement.target.turnId,
      expectedRevision: replacement.target.revision,
      clientMessageId: replacement.clientMessageId,
      text: replacement.draft,
    }).then(() => {
      dispatch({ type: 'success' })
      void Promise.resolve().then(() => controller.refresh?.()).catch(() => undefined)
    }).catch((reason: unknown) => {
      const conflict = reason instanceof ObjectiveReplacementCommandError && reason.status === 409
      dispatch({
        type: 'failed',
        error: { message: reason instanceof Error ? reason.message : 'The request outcome is unknown.', conflict },
      })
    }).finally(() => {
      pendingRef.current = false
    })
  }

  return (
    <div data-testid="active-turn-composer" style={{ marginBottom: 8, padding: '8px 10px', borderRadius: 8, background: 'rgba(79,70,229,0.05)', border: '1px solid rgba(79,70,229,0.14)', color: 'var(--text)', fontSize: 11 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span>Active Turn: {controller.activeTurn?.status ?? 'ready'}{controller.activeTurn ? ` · revision ${controller.activeTurn.revision}` : ''}</span>
        {controller.activeTurn && (
          <button type="button" data-testid="interrupt-turn" onClick={controller.interrupt} disabled={controller.interrupting} style={{ minHeight: 28, padding: '0 9px', border: '1px solid rgba(220,38,38,0.28)', borderRadius: 7, background: 'transparent', color: '#b91c1c', cursor: controller.interrupting ? 'wait' : 'pointer', font: 'inherit', fontWeight: 700 }}>
            {controller.interrupting ? 'Stopping…' : 'Stop'}
          </button>
        )}
      </div>
      <div role="group" aria-label="Turn delivery" style={{ display: 'flex', gap: 6, marginTop: 7, flexWrap: 'wrap' }}>
        {(['steer', 'follow_up'] as const).map(option => (
          <button key={option} type="button" aria-pressed={controller.delivery === option} onClick={() => controller.setDelivery(option)} style={{ minHeight: 28, padding: '0 8px', border: `1px solid ${controller.delivery === option ? 'var(--primary)' : 'var(--border)'}`, borderRadius: 7, background: controller.delivery === option ? 'rgba(79,70,229,0.1)' : 'transparent', color: 'var(--text)', cursor: 'pointer', font: 'inherit', fontSize: 11, fontWeight: 650 }}>
            {option === 'steer' ? 'Steer current Turn' : 'Queue follow-up'}
          </button>
        ))}
      </div>
      {canOpenReplacement && !replacement.open && (
        <button type="button" data-testid="open-objective-replacement" onClick={openReplacement} style={{ marginTop: 7, minHeight: 28, padding: '0 9px', border: '1px solid var(--border)', borderRadius: 7, background: 'transparent', color: 'var(--text)', cursor: 'pointer', font: 'inherit', fontWeight: 700 }}>
          Replace objective
        </button>
      )}
      {replacement.open && replacement.target && (
        <form aria-label="Replace objective" data-testid="objective-replacement-form" onSubmit={submitReplacement} style={{ display: 'grid', gap: 7, marginTop: 8 }}>
          <p style={{ margin: 0 }}>This stops the current run and starts a fresh plan from your new objective.</p>
          <p style={{ margin: 0 }}>Applies to the run selected when this form was opened.</p>
          {targetChanged && <p role="status" style={{ margin: 0 }}>The run changed after you opened this form. Close and reopen to select the current run.</p>}
          <label htmlFor="replacement-objective-text">New objective</label>
          <p style={{ margin: 0 }}>Write a short objective; send detailed context separately.</p>
          <textarea
            id="replacement-objective-text"
            data-testid="objective-replacement-draft"
            aria-label="New objective"
            rows={4}
            value={replacement.draft}
            disabled={replacement.pending}
            onChange={event => dispatch({ type: 'edit', draft: event.target.value, clientMessageId: newClientMessageId() })}
            style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', border: '1px solid var(--border)', borderRadius: 7, padding: 8, color: 'var(--text)', background: 'var(--background)', font: 'inherit' }}
          />
          {replacement.error && (
            <div role="alert" data-testid="objective-replacement-error" style={{ color: '#b91c1c' }}>
              {replacement.error.message}{replacement.error.conflict ? ' Your draft is preserved. Close and reopen to select the current run.' : ' Your draft is preserved. You can retry or edit it.'}
            </div>
          )}
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
            <button type="submit" data-testid="submit-objective-replacement" disabled={!canSubmitObjectiveReplacement(replacement)} style={{ minHeight: 30, padding: '0 10px', border: 0, borderRadius: 7, background: 'var(--primary)', color: 'white', cursor: replacement.pending ? 'wait' : 'pointer', font: 'inherit', fontWeight: 700 }}>
              {replacement.pending ? 'Starting new plan…' : 'Replace objective'}
            </button>
            <button type="button" data-testid="discard-objective-replacement" disabled={replacement.pending} onClick={() => dispatch({ type: 'discard' })} style={{ minHeight: 30, padding: '0 10px', border: '1px solid var(--border)', borderRadius: 7, background: 'transparent', color: 'var(--text)', cursor: replacement.pending ? 'wait' : 'pointer', font: 'inherit' }}>
              Close and discard
            </button>
          </div>
        </form>
      )}
      {controller.commandError && (
        <div role="alert" data-testid="turn-command-error" style={{ marginTop: 7, color: '#b91c1c' }}>
          {controller.commandError.code}: {controller.commandError.message}
        </div>
      )}
      {controller.messages.length > 0 && (
        <div aria-live="polite" style={{ display: 'grid', gap: 3, marginTop: 7 }}>
          {controller.messages.map(message => (
            <div key={message.clientMessageId} data-testid={`turn-message-${message.status}`} style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{message.text}</span>
              <strong>{composerStatusLabel[message.status]}</strong>
              {message.error && <span>{message.error}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function newClientMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `objective-${crypto.randomUUID()}`
  return `objective-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
