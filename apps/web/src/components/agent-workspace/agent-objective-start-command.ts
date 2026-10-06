'use client'

import { InputContentPartSchema, schemaVersion, validate, type InputContentPart } from '@jobcopilot/agent-protocol'

export interface StartAgentObjectiveRequest {
  readonly sessionId: string
  readonly clientMessageId: string
  readonly objective: string
  readonly content: InputContentPart[]
}

export interface ObjectiveStartCommandResult {
  readonly inputId: string
  readonly turnId: string
  readonly disposition: 'started' | 'duplicate'
  readonly sequence: string
  readonly originalDisposition?: 'started' | 'steered' | 'queued_follow_up'
}

export class ObjectiveStartCommandError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Readonly<Record<string, unknown>>

  constructor(status: number, code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message)
    this.name = 'ObjectiveStartCommandError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export function normalizeObjectiveStartDraft(objective: string) {
  const normalizedObjective = typeof objective === 'string' ? objective.trim() : ''
  if (!normalizedObjective || new TextEncoder().encode(normalizedObjective).byteLength > 2_000) {
    throw invalidInput('Write an objective between 1 and 2,000 UTF-8 bytes.')
  }
  return normalizedObjective
}

export async function startAgentObjective(
  request: StartAgentObjectiveRequest,
  fetcher: typeof fetch = fetch,
): Promise<ObjectiveStartCommandResult> {
  const objective = normalizeObjectiveStartDraft(request.objective)
  validateIdentifier(request.sessionId, 'Session ID')
  validateIdentifier(request.clientMessageId, 'Client message ID')
  validateContent(request.content)
  const response = await fetcher(
    `/api/agent/sessions/${encodeURIComponent(request.sessionId)}/start-objective`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.clientMessageId },
      body: JSON.stringify({ schemaVersion, clientMessageId: request.clientMessageId, objective, content: request.content }),
    },
  )
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) throw parseError(response.status, body)
  if (response.status !== 202) throw new Error('Task start returned an unexpected status.')
  return parseResult(body)
}

function validateContent(value: InputContentPart[]): void {
  if (!Array.isArray(value) || value.length === 0) throw invalidInput('Supporting content is required.')
  let textLength = 0
  for (const part of value) {
    if (!validate(InputContentPartSchema, part)) throw invalidInput('Supporting content is invalid.')
    if (part.type === 'text') textLength += part.text.length
  }
  if (textLength > 20_000) throw invalidInput('Supporting text must be 20,000 characters or fewer.')
}

function validateIdentifier(value: string, label: string): void {
  if (typeof value !== 'string' || !value || value.length > 256 || value.trim() !== value) {
    throw invalidInput(`${label} is invalid.`)
  }
}

function invalidInput(message: string): ObjectiveStartCommandError {
  return new ObjectiveStartCommandError(422, 'invalid_command', message)
}

function parseError(status: number, value: unknown): ObjectiveStartCommandError {
  const root = record(value) ? value : {}
  const error = record(root.error) ? root.error : {}
  return new ObjectiveStartCommandError(
    status,
    nonempty(error.code) ? error.code : 'command_failed',
    nonempty(error.message) ? error.message : `Task could not be started (${status}).`,
    record(error.details) ? error.details : {},
  )
}

function parseResult(value: unknown): ObjectiveStartCommandResult {
  if (!record(value) || !nonempty(value.inputId) || !nonempty(value.turnId)
    || typeof value.sequence !== 'string'
    || (value.disposition !== 'started' && value.disposition !== 'duplicate')) {
    throw new Error('Task start returned an invalid response.')
  }
  const original = value.originalDisposition
  if (original !== undefined && original !== 'started' && original !== 'steered' && original !== 'queued_follow_up') {
    throw new Error('Task start returned an invalid original disposition.')
  }
  return {
    inputId: value.inputId,
    turnId: value.turnId,
    disposition: value.disposition,
    sequence: value.sequence,
    ...(original === undefined ? {} : { originalDisposition: original }),
  }
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
