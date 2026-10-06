'use client'

import React, { useRef, useState, type FormEvent } from 'react'
import type { InputContentPart } from '@jobcopilot/agent-protocol'
import {
  ObjectiveStartCommandError,
  normalizeObjectiveStartDraft,
  startAgentObjective,
  type StartAgentObjectiveRequest,
} from './agent-objective-start-command'
import type { AgentUnifiedStreamProps } from './AgentUnifiedStream.types'

interface ObjectiveStartIdentity {
  readonly signature: string
  readonly clientMessageId: string
}

export interface ObjectiveStartFlowMemory {
  sessionId: string | null
  identity: ObjectiveStartIdentity | null
  pending: boolean
  accepted: boolean
}

export interface ObjectiveStartDraft {
  objective: string
  background: string
}

export interface ObjectiveStartFlowDependencies {
  createSession: (objective: string) => Promise<string>
  startCommand: (request: StartAgentObjectiveRequest) => Promise<unknown>
  onAccepted: (sessionId: string, objective: string) => void | Promise<void>
  newClientMessageId?: () => string
}

export class ObjectiveSessionCreationError extends Error {
  constructor() {
    super('The task session could not be confirmed. No task was started; you can try again.')
    this.name = 'ObjectiveSessionCreationError'
  }
}

export function createObjectiveStartFlowMemory(): ObjectiveStartFlowMemory {
  return { sessionId: null, identity: null, pending: false, accepted: false }
}

export function invalidateObjectiveStartIdentity(memory: ObjectiveStartFlowMemory): void {
  if (!memory.pending && !memory.accepted) memory.identity = null
}

export async function submitObjectiveStartFlow(
  memory: ObjectiveStartFlowMemory,
  draft: ObjectiveStartDraft,
  dependencies: ObjectiveStartFlowDependencies,
): Promise<{ accepted: boolean; inFlight: boolean; callbackFailed?: boolean }> {
  if (memory.pending || memory.accepted) return { accepted: memory.accepted, inFlight: memory.pending }
  const objective = normalizeObjectiveStartDraft(draft.objective)
  if (draft.background.length > 20_000) {
    throw new ObjectiveStartCommandError(422, 'invalid_command', 'Supporting context must be 20,000 characters or fewer.')
  }
  const signature = JSON.stringify([draft.objective, draft.background])
  if (!memory.identity || memory.identity.signature !== signature) {
    memory.identity = { signature, clientMessageId: (dependencies.newClientMessageId ?? newClientMessageId)() }
  }

  memory.pending = true
  try {
    if (!memory.sessionId) {
      try {
        const createdSessionId = await dependencies.createSession(objective)
        if (!createdSessionId || createdSessionId.length > 256 || createdSessionId.trim() !== createdSessionId) throw new Error()
        memory.sessionId = createdSessionId
      } catch {
        throw new ObjectiveSessionCreationError()
      }
    }
    const content: InputContentPart[] = [{ type: 'text', text: draft.background === '' ? objective : draft.background }]
    await dependencies.startCommand({
      sessionId: memory.sessionId,
      clientMessageId: memory.identity.clientMessageId,
      objective,
      content,
    })
    memory.accepted = true
    try {
      await dependencies.onAccepted(memory.sessionId, objective)
      return { accepted: true, inFlight: false }
    } catch {
      return { accepted: true, inFlight: false, callbackFailed: true }
    }
  } finally {
    memory.pending = false
  }
}

export async function createSessionForObjective(objective: string, fetcher: typeof fetch = fetch): Promise<string> {
  const normalizedObjective = normalizeObjectiveStartDraft(objective)
  const response = await fetcher('/api/agent/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal: normalizedObjective }),
  })
  const body: unknown = await response.json().catch(() => null)
  const session = record(body) && record(body.session) ? body.session : null
  const sessionId = session && typeof session.id === 'string' ? session.id : ''
  if (!response.ok || !sessionId || sessionId.length > 256 || sessionId.trim() !== sessionId) {
    throw new Error('Could not create a task session.')
  }
  return sessionId
}

interface AgentObjectiveContextFormProps {
  onClose: () => void
  onSessionRecorded: AgentUnifiedStreamProps['onSessionRecorded']
  acquireAdmission: () => boolean
  releaseAdmission: () => void
  onBusyChange: (busy: boolean) => void
}

export function AgentObjectiveContextForm({
  onClose, onSessionRecorded, acquireAdmission, releaseAdmission, onBusyChange,
}: AgentObjectiveContextFormProps) {
  const [objective, setObjective] = useState('')
  const [background, setBackground] = useState('')
  const [pending, setPending] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [error, setError] = useState<{ message: string; conflict: boolean } | null>(null)
  const memory = useRef(createObjectiveStartFlowMemory())
  const pendingRef = useRef(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pendingRef.current || accepted) return
    if (!acquireAdmission()) {
      setError({ message: 'Wait for the current message to finish, then try again.', conflict: false })
      return
    }
    pendingRef.current = true
    setPending(true)
    setError(null)
    onBusyChange(true)
    try {
      const result = await submitObjectiveStartFlow(memory.current, { objective, background }, {
        createSession: value => createSessionForObjective(value),
        startCommand: request => startAgentObjective(request),
        onAccepted: (sessionId, goal) => onSessionRecorded(sessionId, goal, 'Chat · Running'),
      })
      if (result.accepted) {
        setAccepted(true)
        if (result.callbackFailed) setError({ message: 'Task started, but this page could not open it. Find it in your task list.', conflict: false })
        else onClose()
      }
    } catch (reason) {
      const conflict = reason instanceof ObjectiveStartCommandError && reason.status === 409
      const message = reason instanceof ObjectiveStartCommandError || reason instanceof ObjectiveSessionCreationError
        ? reason.message
        : 'The result is unknown. Retry this same draft to check the request.'
      setError({ message, conflict })
    } finally {
      pendingRef.current = false
      setPending(false)
      onBusyChange(false)
      releaseAdmission()
    }
  }

  return (
    <form aria-label="Start a task with context" data-testid="objective-context-form" onSubmit={submit} style={{ display: 'grid', gap: 8, margin: '8px 0', padding: 12, border: '1px solid var(--border)', borderRadius: 10 }}>
      <div>
        <strong>Start a task with context</strong>
        <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 12 }}>This starts a fresh task. It does not change an existing run.</p>
      </div>
      <label htmlFor="agent-task-objective">Task objective</label>
      <p style={{ margin: '-4px 0 0', color: 'var(--muted)', fontSize: 12 }}>State the outcomes required to complete this task.</p>
      <textarea id="agent-task-objective" data-testid="objective-context-objective" rows={2} value={objective} disabled={pending || accepted || Boolean(error?.conflict)} onChange={event => { setObjective(event.target.value); invalidateObjectiveStartIdentity(memory.current); setError(null) }} style={fieldStyle} />
      <label htmlFor="agent-task-background">Supporting context (optional)</label>
      <p style={{ margin: '-4px 0 0', color: 'var(--muted)', fontSize: 12 }}>Add reference material and details that support the objective.</p>
      <textarea id="agent-task-background" data-testid="objective-context-background" rows={5} value={background} disabled={pending || accepted || Boolean(error?.conflict)} onChange={event => { setBackground(event.target.value); invalidateObjectiveStartIdentity(memory.current); setError(null) }} style={fieldStyle} />
      <div aria-live="polite" style={{ color: 'var(--muted)', fontSize: 11 }}>{background.length}/20,000 characters</div>
      {error && <div role={error.conflict ? 'alert' : 'status'} data-testid="objective-context-error" style={{ color: error.conflict ? '#b91c1c' : 'var(--muted)' }}>{error.message}{error.conflict ? ' Your draft is preserved. Close this form to stop here.' : ''}</div>}
      {accepted && !error && <div role="status">Task started.</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {!accepted && <button type="submit" data-testid="objective-context-submit" disabled={pending || Boolean(error?.conflict) || !objective.trim()}>{pending ? 'Starting task…' : error ? 'Try again' : 'Start task'}</button>}
        <button type="button" data-testid="objective-context-close" disabled={pending} onClick={onClose}>{accepted ? 'Done' : 'Close and discard'}</button>
      </div>
    </form>
  )
}

const fieldStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box', resize: 'vertical', border: '1px solid var(--border)', borderRadius: 7, padding: 8, color: 'var(--text)', background: 'var(--background)', font: 'inherit' }

function newClientMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `objective-start-${crypto.randomUUID()}`
  return `objective-start-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
