'use client'

import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { schemaVersion, type InputContentPart } from '@jobcopilot/agent-protocol'
import type { ActiveTurnDto } from './agent-session-state'

export type ComposerDelivery = 'steer' | 'follow_up'
export type ComposerMessageStatus = 'sending' | 'accepted' | 'consumed' | 'failed'

export interface ComposerMessage {
  clientMessageId: string
  text: string
  delivery: ComposerDelivery
  status: ComposerMessageStatus
  inputId?: string
  turnId?: string
  error?: string
}

export interface TurnCommandResult {
  inputId: string
  turnId: string
  disposition: 'started' | 'steered' | 'queued_follow_up' | 'duplicate'
  originalDisposition?: 'started' | 'steered' | 'queued_follow_up'
  sequence: string
}

export interface AgentCommandErrorDto {
  code: string
  message: string
  details: Record<string, unknown>
  status: number
}

export class AgentTurnCommandError extends Error implements AgentCommandErrorDto {
  readonly code: string
  readonly details: Record<string, unknown>
  readonly status: number

  constructor(dto: AgentCommandErrorDto) {
    super(dto.message)
    this.name = 'AgentTurnCommandError'
    this.code = dto.code
    this.details = dto.details
    this.status = dto.status
  }
}

export interface TurnComposerController {
  sessionId: string
  activeTurn: ActiveTurnDto | null
  delivery: ComposerDelivery
  setDelivery: (delivery: ComposerDelivery) => void
  chatInput: string
  setChatInput: (value: string) => void
  sending: boolean
  messages: ComposerMessage[]
  commandError: AgentCommandErrorDto | null
  send: (text: string) => void
  interrupt: () => void
  interrupting: boolean
}

export async function sendAgentTurnMessage(
  sessionId: string,
  text: string,
  delivery: ComposerDelivery,
  activeTurn: ActiveTurnDto | null,
  clientMessageId: string,
  fetcher: typeof fetch = fetch,
): Promise<TurnCommandResult> {
  const content: InputContentPart[] = [{ type: 'text', text: text.trim() }]
  const response = await fetcher(`/api/agent/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': clientMessageId },
    body: JSON.stringify({
      schemaVersion,
      clientMessageId,
      delivery,
      expectedTurnId: delivery === 'steer' ? activeTurn?.id ?? null : null,
      expectedRevision: delivery === 'steer' ? activeTurn?.revision ?? null : null,
      content,
    }),
  })
  const body = await response.json().catch(() => ({})) as unknown
  if (!response.ok) throw commandErrorFromResponse(response.status, body)
  return parseTurnCommandResult(body)
}

export async function sendAgentInterrupt(
  sessionId: string,
  activeTurn: ActiveTurnDto,
  clientMessageId: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(`/api/agent/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(activeTurn.id)}/interrupt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': clientMessageId },
    body: JSON.stringify({ clientMessageId, expectedRevision: activeTurn.revision }),
  })
  const body = await response.json().catch(() => ({})) as unknown
  if (!response.ok) throw commandErrorFromResponse(response.status, body)
}

export function reconcileComposerMessage(messages: ComposerMessage[], clientMessageId: string, patch: Partial<ComposerMessage>): ComposerMessage[] {
  return messages.map((message) => message.clientMessageId === clientMessageId ? { ...message, ...patch } : message)
}

function parseTurnCommandResult(value: unknown): TurnCommandResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Agent command returned an invalid response')
  const row = value as Record<string, unknown>
  if (typeof row.inputId !== 'string' || typeof row.turnId !== 'string' || typeof row.sequence !== 'string') throw new Error('Agent command returned an invalid response')
  if (!['started', 'steered', 'queued_follow_up', 'duplicate'].includes(String(row.disposition))) throw new Error('Agent command returned an invalid disposition')
  return {
    inputId: row.inputId,
    turnId: row.turnId,
    disposition: row.disposition as TurnCommandResult['disposition'],
    originalDisposition: ['started', 'steered', 'queued_follow_up'].includes(String(row.originalDisposition)) ? row.originalDisposition as TurnCommandResult['originalDisposition'] : undefined,
    sequence: row.sequence,
  }
}

function commandErrorFromResponse(status: number, value: unknown): AgentTurnCommandError {
  const root = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const error = root.error && typeof root.error === 'object' && !Array.isArray(root.error) ? root.error as Record<string, unknown> : {}
  return new AgentTurnCommandError({
    status,
    code: typeof error.code === 'string' ? error.code : 'command_failed',
    message: typeof error.message === 'string' ? error.message : `Agent command failed (${status})`,
    details: error.details && typeof error.details === 'object' && !Array.isArray(error.details) ? error.details as Record<string, unknown> : {},
  })
}

function newClientMessageId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `${prefix}-${crypto.randomUUID()}`
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const AgentTurnComposerContext = createContext<TurnComposerController | null>(null)

export function AgentTurnComposerProvider({ value, children }: { value: TurnComposerController | null; children: ReactNode }) {
  return createElement(AgentTurnComposerContext.Provider, { value }, children)
}

export function useAgentTurnComposerContext() {
  return useContext(AgentTurnComposerContext)
}

export function useAgentTurnComposer(sessionId: string | null, activeTurn: ActiveTurnDto | null, refetch: () => void): TurnComposerController | null {
  const [delivery, setDelivery] = useState<ComposerDelivery>('steer')
  const [chatInput, setChatInput] = useState('')
  const [messages, setMessages] = useState<ComposerMessage[]>([])
  const [sending, setSending] = useState(false)
  const [commandError, setCommandError] = useState<AgentCommandErrorDto | null>(null)
  const [interrupting, setInterrupting] = useState(false)
  const requestGenerationRef = useRef(0)

  useEffect(() => {
    requestGenerationRef.current += 1
    setChatInput('')
    setMessages([])
    setCommandError(null)
    setDelivery('steer')
    setSending(false)
    setInterrupting(false)
  }, [sessionId])

  useEffect(() => {
    const onConsumed = (event: Event) => {
      const detail = event instanceof CustomEvent && event.detail && typeof event.detail === 'object' ? event.detail as Record<string, unknown> : null
      const clientMessageId = typeof detail?.clientMessageId === 'string' ? detail.clientMessageId : null
      const inputId = typeof detail?.inputId === 'string' ? detail.inputId : null
      if (!clientMessageId && !inputId) return
      setMessages((current) => current.map((message) => message.clientMessageId === clientMessageId || message.inputId === inputId ? { ...message, status: 'consumed' } : message))
    }
    window.addEventListener('applymate:agent-input-consumed', onConsumed)
    return () => window.removeEventListener('applymate:agent-input-consumed', onConsumed)
  }, [])

  const send = useCallback((text: string) => {
    if (!sessionId || !text.trim() || sending) return
    const clientMessageId = newClientMessageId('message')
    const outgoing = text.trim()
    setChatInput('')
    setCommandError(null)
    setMessages((current) => [...current, { clientMessageId, text: outgoing, delivery, status: 'sending' }])
    setSending(true)
    const requestGeneration = requestGenerationRef.current
    void sendAgentTurnMessage(sessionId, outgoing, delivery, activeTurn, clientMessageId)
      .then((result) => {
        if (requestGeneration !== requestGenerationRef.current) return
        setMessages((current) => reconcileComposerMessage(current, clientMessageId, { status: 'accepted', inputId: result.inputId, turnId: result.turnId }))
        refetch()
      })
      .catch((reason: unknown) => {
        if (requestGeneration !== requestGenerationRef.current) return
        const error = reason instanceof AgentTurnCommandError ? reason : new AgentTurnCommandError({ status: 500, code: 'command_failed', message: reason instanceof Error ? reason.message : 'Agent command failed', details: {} })
        setCommandError(error)
        setMessages((current) => reconcileComposerMessage(current, clientMessageId, { status: 'failed', error: error.status === 409 ? `409 ${error.message}` : error.message }))
        setChatInput(outgoing)
      })
      .finally(() => { if (requestGeneration === requestGenerationRef.current) setSending(false) })
  }, [activeTurn, delivery, refetch, sending, sessionId])

  const interrupt = useCallback(() => {
    if (!sessionId || !activeTurn || interrupting) return
    const clientMessageId = newClientMessageId('interrupt')
    const requestGeneration = requestGenerationRef.current
    setCommandError(null)
    setInterrupting(true)
    void sendAgentInterrupt(sessionId, activeTurn, clientMessageId)
      .then(() => { if (requestGeneration === requestGenerationRef.current) refetch() })
      .catch((reason: unknown) => {
        if (requestGeneration !== requestGenerationRef.current) return
        const error = reason instanceof AgentTurnCommandError ? reason : new AgentTurnCommandError({ status: 500, code: 'interrupt_failed', message: reason instanceof Error ? reason.message : 'Interrupt failed', details: {} })
        setCommandError(error)
      })
      .finally(() => { if (requestGeneration === requestGenerationRef.current) setInterrupting(false) })
  }, [activeTurn, interrupting, refetch, sessionId])

  if (!sessionId) return null
  return { sessionId, activeTurn, delivery, setDelivery, chatInput, setChatInput, sending, messages, commandError, send, interrupt, interrupting }
}
