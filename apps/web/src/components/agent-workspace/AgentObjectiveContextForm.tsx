'use client'

import React, { useEffect, useReducer, useRef, type FormEvent, type MutableRefObject } from 'react'
import {
  AgentObjectiveStartCoordinator,
  ObjectiveStartCommandError,
  type ObjectiveContextDraft,
} from './agent-objective-start-command'

export interface AgentObjectiveContextFormState extends ObjectiveContextDraft {
  open: boolean
  pending: boolean
  accepted: boolean
  error: { message: string; conflict: boolean } | null
}

type FormAction =
  | { type: 'open' }
  | { type: 'edit-objective'; value: string }
  | { type: 'edit-context'; value: string }
  | { type: 'pending' }
  | { type: 'failed'; error: { message: string; conflict: boolean } }
  | { type: 'accepted' }
  | { type: 'callback-failed'; message: string }
  | { type: 'discard' }

const initialFormState: AgentObjectiveContextFormState = {
  objective: '', context: '', open: false, pending: false, accepted: false, error: null,
}

export function objectiveContextFormReducer(
  state: AgentObjectiveContextFormState,
  action: FormAction,
): AgentObjectiveContextFormState {
  if (action.type === 'open') return { ...initialFormState, open: true }
  if (action.type === 'edit-objective') return { ...state, objective: action.value, error: null }
  if (action.type === 'edit-context') return { ...state, context: action.value, error: null }
  if (action.type === 'pending') return { ...state, pending: true, error: null }
  if (action.type === 'failed') return { ...state, pending: false, error: action.error }
  if (action.type === 'accepted') return { ...initialFormState, accepted: true }
  if (action.type === 'callback-failed') {
    return { ...initialFormState, accepted: true, error: { message: action.message, conflict: false } }
  }
  return initialFormState
}

export function isObjectiveDraftPending(state: Pick<AgentObjectiveContextFormState, "open" | "accepted">): boolean {
  return state.open && !state.accepted
}

export function canStartOrdinaryChat(objectiveDraftPending: boolean): boolean {
  return !objectiveDraftPending
}

export function isOrdinaryComposerInputLocked(objectiveStartInFlight: boolean, sessionSwitchPending: boolean): boolean {
  return objectiveStartInFlight || sessionSwitchPending
}

export function shouldReleaseInputAfterSessionSelection(
  wasEntryAvailable: boolean,
  entryAvailable: boolean,
  sessionSwitchPending: boolean,
): boolean {
  return wasEntryAvailable && !entryAvailable && sessionSwitchPending
}

export function canSubmitObjectiveContext(state: AgentObjectiveContextFormState): boolean {
  return state.open && !state.pending && !state.accepted && Boolean(state.objective.trim())
}

interface AgentObjectiveContextFormProps {
  startLockRef: MutableRefObject<boolean>
  attachedFileCount?: number
  ordinaryComposerDraftPresent?: boolean
  available?: boolean
  disabled?: boolean
  onBusyChange?: (busy: boolean) => void
  onAccepted: (sessionId: string, objective: string) => void
  onDraftPendingChange?: (pending: boolean) => void
}

export function AgentObjectiveContextForm({ startLockRef, attachedFileCount = 0, ordinaryComposerDraftPresent = false, available = true, disabled = false, onBusyChange, onAccepted, onDraftPendingChange }: AgentObjectiveContextFormProps) {
  const [state, dispatch] = useReducer(objectiveContextFormReducer, initialFormState)
  const pendingRef = useRef(false)
  const wasAvailableRef = useRef(available)
  const coordinatorRef = useRef<AgentObjectiveStartCoordinator | null>(null)
  if (!coordinatorRef.current) coordinatorRef.current = new AgentObjectiveStartCoordinator()
  const dispatchAction = (action: FormAction) => {
    const nextState = objectiveContextFormReducer(state, action)
    onDraftPendingChange?.(isObjectiveDraftPending(nextState))
    dispatch(action)
  }

  useEffect(() => {
    const becameAvailable = available && !wasAvailableRef.current
    wasAvailableRef.current = available
    if (!becameAvailable || !state.accepted) return
    coordinatorRef.current?.discard()
    onDraftPendingChange?.(false)
    dispatch({ type: 'discard' })
  }, [available, onDraftPendingChange, state.accepted])

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmitObjectiveContext(state) || disabled || attachedFileCount > 0 || ordinaryComposerDraftPresent || pendingRef.current || startLockRef.current) return
    pendingRef.current = true
    startLockRef.current = true
    onBusyChange?.(true)
    dispatchAction({ type: 'pending' })
    void coordinatorRef.current!.start(state.objective, state.context).then(result => {
      dispatchAction({ type: 'accepted' })
      try {
        onAccepted(result.sessionId, result.objective)
      } catch (error) {
        dispatchAction({ type: 'callback-failed', message: error instanceof Error ? error.message : 'The workspace could not be opened.' })
      }
    }).catch((error: unknown) => {
      dispatchAction({
        type: 'failed',
        error: {
          message: error instanceof Error ? error.message : 'The request outcome is unknown.',
          conflict: error instanceof ObjectiveStartCommandError && error.status === 409,
        },
      })
    }).finally(() => {
      pendingRef.current = false
      startLockRef.current = false
      onBusyChange?.(false)
    })
  }

  const discard = () => {
    if (pendingRef.current) return
    coordinatorRef.current?.discard()
    dispatchAction({ type: 'discard' })
  }

  if (!available) return null

  return (
    <section data-testid="objective-context-entry" style={{ marginBottom: 8, padding: '9px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text)', fontSize: 12 }}>
      {state.accepted ? (
        <div role={state.error ? 'alert' : 'status'} data-testid="objective-context-accepted">
          {state.error ? `Task started, but the workspace could not be opened: ${state.error.message}` : 'Task started.'}
        </div>
      ) : !state.open ? (
        <button type="button" data-testid="open-objective-context" disabled={disabled} onClick={() => dispatchAction({ type: 'open' })} style={{ minHeight: 30, padding: '0 10px', border: '1px solid var(--border)', borderRadius: 7, background: 'transparent', color: 'var(--text)', cursor: disabled ? 'wait' : 'pointer', font: 'inherit', fontWeight: 700 }}>
          Start with an objective and background
        </button>
      ) : (
        <form aria-label="Start a task with an objective and background" data-testid="objective-context-form" onSubmit={submit} style={{ display: 'grid', gap: 7 }}>
          <p style={{ margin: 0 }}>The objective defines what must be complete. Background is reference material for the task.</p>
          <label htmlFor="agent-task-objective">Completion objective</label>
          <p style={{ margin: 0 }}>Write the outcome you want, in 2,000 UTF-8 bytes or fewer.</p>
          <textarea
            id="agent-task-objective"
            data-testid="objective-context-objective"
            aria-label="Completion objective"
            rows={2}
            value={state.objective}
            disabled={state.pending || disabled}
            onChange={event => {
              coordinatorRef.current?.draftEdited()
              dispatchAction({ type: 'edit-objective', value: event.target.value })
            }}
            style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', border: '1px solid var(--border)', borderRadius: 7, padding: 8, color: 'var(--text)', background: 'var(--bg)', font: 'inherit' }}
          />
          <label htmlFor="agent-task-background">Background and reference</label>
          <p style={{ margin: 0 }}>Optional, up to 20,000 characters. Text is sent unchanged.</p>
          <textarea
            id="agent-task-background"
            data-testid="objective-context-background"
            aria-label="Background and reference"
            rows={4}
            value={state.context}
            disabled={state.pending || disabled}
            onChange={event => {
              coordinatorRef.current?.draftEdited()
              dispatchAction({ type: 'edit-context', value: event.target.value })
            }}
            style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', border: '1px solid var(--border)', borderRadius: 7, padding: 8, color: 'var(--text)', background: 'var(--bg)', font: 'inherit' }}
          />
          {(attachedFileCount > 0 || ordinaryComposerDraftPresent) && (
            <p role="status" data-testid="objective-context-attachments" style={{ margin: 0 }}>
              This start uses only the text above. Clear the regular composer draft{attachedFileCount > 0 ? ` and remove its ${attachedFileCount} attached file${attachedFileCount === 1 ? '' : 's'}` : ''} before continuing; that content will not be sent or discarded here.
            </p>
          )}
          {state.error && (
            <div role="alert" data-testid="objective-context-error" style={{ color: '#b91c1c' }}>
              {state.error.message}{state.error.conflict
                ? ' Your draft is preserved. No existing run was changed; edit or retry explicitly.'
                : ' Your draft is preserved. You can retry or edit it.'}
            </div>
          )}
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
            <button type="submit" data-testid="submit-objective-context" disabled={!canSubmitObjectiveContext(state) || disabled || attachedFileCount > 0 || ordinaryComposerDraftPresent || startLockRef.current} style={{ minHeight: 30, padding: '0 10px', border: 0, borderRadius: 7, background: 'var(--primary)', color: 'white', cursor: state.pending ? 'wait' : 'pointer', font: 'inherit', fontWeight: 700 }}>
              {state.pending ? 'Starting task…' : 'Start task'}
            </button>
            <button type="button" data-testid="discard-objective-context" disabled={state.pending} onClick={discard} style={{ minHeight: 30, padding: '0 10px', border: '1px solid var(--border)', borderRadius: 7, background: 'transparent', color: 'var(--text)', cursor: state.pending ? 'wait' : 'pointer', font: 'inherit' }}>
              Discard draft
            </button>
          </div>
        </form>
      )}
    </section>
  )
}
