import type { ObjectiveStartResult } from './agent-objective-start-command'
import { AgentComposerTaskAttemptRegistry, type ComposerTaskAttemptTarget } from './agent-composer-task-attempts'
import { AgentComposerTaskAttemptStore } from './agent-composer-task-attempt-store'
import { AgentComposerTaskRecoveryController } from './agent-composer-task-recovery'
import {
  AgentComposerTaskRecoveryError,
  classifyRecoveryError,
  parseRecoveryAccountIndex,
  validRecoveryId,
  type AgentComposerTaskRecoveryNoticeState,
  type AgentComposerTaskRecoverySnapshot,
} from './agent-composer-task-recovery-protocol'

type StorePort = Pick<AgentComposerTaskAttemptStore, 'list' | 'reserve' | 'advance' | 'bindCreatedSession' | 'removeResolved'>
type ControllerPort = Pick<AgentComposerTaskRecoveryController, 'load'>

export type RecoverableComposerTaskOutcome =
  | Readonly<{ kind: 'accepted'; attemptKey: string; accountScope: string; result: ObjectiveStartResult }>
  | Readonly<{ kind: 'recovery'; attemptKey: string; state: AgentComposerTaskRecoveryNoticeState; snapshot?: AgentComposerTaskRecoverySnapshot }>
  | Readonly<{ kind: 'unavailable'; attemptKey?: string; state: Readonly<{ kind: 'unavailable'; reason: 'storage' | 'error' }>; snapshot?: AgentComposerTaskRecoverySnapshot }>
  | Readonly<{ kind: 'stale' }>

export async function startRecoverableComposerTask(options: {
  readonly target: ComposerTaskAttemptTarget
  readonly objective: string
  readonly store?: StorePort
  readonly controller: ControllerPort
  readonly fetcher?: typeof fetch
  readonly makeAttemptKey?: () => string
  readonly expectedAccountScope?: string
  readonly isCurrent: () => boolean
}): Promise<RecoverableComposerTaskOutcome> {
  const fetcher = (options.fetcher ?? globalThis.fetch).bind(globalThis)
  const store = options.store ?? new AgentComposerTaskAttemptStore()
  let scope = ''
  let attemptKey = ''
  const assertCurrent = () => { if (!options.isCurrent()) throw new AgentComposerTaskRecoveryError('error') }
  try {
    scope = await readScope(fetcher, assertCurrent)
    if (options.expectedAccountScope && options.expectedAccountScope !== scope) throw new AgentComposerTaskRecoveryError('error')
    const rows = await store.list(scope)
    assertCurrent()
    const targetSlot = options.target.kind === 'new-session' ? 'new-session' : JSON.stringify(['session', options.target.sessionId])
    const prior = rows.find(row => row.targetSlot === targetSlot)
    attemptKey = prior?.attemptKey ?? (options.makeAttemptKey ?? newClientMessageId)()
    if (!validRecoveryId(attemptKey, 128)) throw new AgentComposerTaskRecoveryError('error')
    const reservation = await store.reserve(scope, options.target, attemptKey,
      prior?.createKey ?? (options.target.kind === 'new-session' ? attemptKey : undefined))
    assertCurrent()
    await verifyScope(fetcher, scope, assertCurrent)
    if (reservation.status === 'existing') {
      const snapshot = await options.controller.load()
      assertCurrent()
      if (snapshot.kind === 'unavailable') return { kind: 'unavailable', attemptKey: reservation.attempt.attemptKey,
        state: { kind: 'unavailable', reason: snapshot.reason }, snapshot }
      const item = snapshot.attempts.find(row => row.attemptKey === reservation.attempt.attemptKey)
      return item ? { kind: 'recovery', attemptKey: item.attemptKey, state: item.state, snapshot }
        : { kind: 'unavailable', attemptKey: reservation.attempt.attemptKey, state: { kind: 'unavailable', reason: 'storage' }, snapshot }
    }

    let createdSessionId: string | null = null
    const scopedFetcher: typeof fetch = async (input, init) => {
      const path = requestPath(input)
      const method = requestMethod(input, init)
      const isCreate = method === 'POST' && path === '/api/agent/sessions'
      const startMatch = method === 'POST' ? path.match(/^\/api\/agent\/sessions\/([^/]+)\/start-objective$/) : null
      if (!isCreate && !startMatch) throw new AgentComposerTaskRecoveryError('error')

      const phase = isCreate ? 'create-requested' : 'start-requested'
      await store.advance(scope, attemptKey, phase)
      assertCurrent()
      await verifyScope(fetcher, scope, assertCurrent)
      const response = await fetcher(input, withExpectedScope(init, scope))
      assertCurrent()
      if (response.ok && response.headers.get('X-Account-Scope') !== scope) throw new AgentComposerTaskRecoveryError('error')
      await verifyScope(fetcher, scope, assertCurrent)
      if (!response.ok) return response

      const body = await response.clone().json().catch(() => null) as unknown
      assertCurrent()
      if (isCreate) {
        const sessionId = createdSessionIdFrom(body)
        if (!sessionId) return response
        await store.bindCreatedSession(scope, attemptKey, sessionId)
        assertCurrent()
        createdSessionId = sessionId
        await verifyScope(fetcher, scope, assertCurrent)
      } else if (isAcceptedStart(body)) {
        const pathSessionId = decodeURIComponent(startMatch![1]!)
        const expectedSessionId = options.target.kind === 'selected-session' ? options.target.sessionId : createdSessionId
        if (!expectedSessionId || pathSessionId !== expectedSessionId) throw new AgentComposerTaskRecoveryError('error')
        await store.advance(scope, attemptKey, 'accepted')
        assertCurrent()
        await verifyScope(fetcher, scope, assertCurrent)
      }
      return response
    }

    const registry = new AgentComposerTaskAttemptRegistry({ fetcher: scopedFetcher, makeClientMessageId: () => attemptKey })
    const coordinator = registry.get(options.target, options.objective)
    const result = options.target.kind === 'selected-session'
      ? await coordinator.start(options.objective, '', options.target.sessionId)
      : await coordinator.start(options.objective, '')
    assertCurrent()
    await verifyScope(fetcher, scope, assertCurrent)
    return { kind: 'accepted', attemptKey, accountScope: scope, result }
  } catch (error) {
    if (!options.isCurrent()) return { kind: 'stale' }
    const reason = classifyRecoveryError(error)
    if (!attemptKey) return { kind: 'unavailable', state: { kind: 'unavailable', reason: reason === 'storage' ? 'storage' : 'error' } }
    try {
      const snapshot = await options.controller.load()
      assertCurrent()
      if (snapshot.kind === 'unavailable') return { kind: 'unavailable', attemptKey,
        state: { kind: 'unavailable', reason: snapshot.reason }, snapshot }
      const item = snapshot.attempts.find(row => row.attemptKey === attemptKey)
      return item ? { kind: 'recovery', attemptKey, state: item.state, snapshot }
        : { kind: 'unavailable', attemptKey, state: { kind: 'unavailable', reason: reason === 'storage' ? 'storage' : 'error' }, snapshot }
    } catch (recoveryError) {
      return { kind: 'unavailable', attemptKey,
        state: { kind: 'unavailable', reason: classifyRecoveryError(recoveryError) === 'storage' ? 'storage' : 'error' } }
    }
  }
}

export async function consumeAcceptedComposerTaskAttempt(options: {
  readonly store: Pick<AgentComposerTaskAttemptStore, 'removeResolved'>
  readonly accountScope: string
  readonly attemptKey: string
  readonly fetcher?: typeof fetch
}): Promise<boolean> {
  try {
    const fetcher = (options.fetcher ?? globalThis.fetch).bind(globalThis)
    const currentScope = await readScope(fetcher, () => undefined)
    return currentScope === options.accountScope && await options.store.removeResolved(options.accountScope, options.attemptKey)
  } catch { return false }
}

async function readScope(fetcher: typeof fetch, assertCurrent: () => void): Promise<string> {
  const response = await fetcher('/api/agent/objective-start-attempts?limit=20', {
    method: 'GET', cache: 'no-store', credentials: 'same-origin',
  })
  assertCurrent()
  if (!response.ok) throw new AgentComposerTaskRecoveryError('error')
  const body = await response.json().catch(() => null) as unknown
  assertCurrent()
  return parseRecoveryAccountIndex(body, response)
}

async function verifyScope(fetcher: typeof fetch, expected: string, assertCurrent: () => void): Promise<void> {
  if (await readScope(fetcher, assertCurrent) !== expected) throw new AgentComposerTaskRecoveryError('error')
  assertCurrent()
}

function withExpectedScope(init: RequestInit | undefined, scope: string): RequestInit {
  const headers = new Headers(init?.headers)
  headers.set('X-Expected-Account-Scope', scope)
  return { ...init, headers, cache: 'no-store', credentials: 'same-origin' }
}

function requestPath(input: RequestInfo | URL): string {
  const raw = input instanceof Request ? input.url : String(input)
  try { return new URL(raw, 'http://localhost').pathname } catch { return '' }
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
}

function createdSessionIdFrom(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.session) || !validRecoveryId(value.session.id)) return null
  return value.session.id
}

function isAcceptedStart(value: unknown): boolean {
  return isRecord(value) && validRecoveryId(value.inputId) && validRecoveryId(value.turnId)
    && typeof value.sequence === 'string' && /^[0-9]{1,20}$/.test(value.sequence)
    && (value.disposition === 'started' || value.disposition === 'duplicate')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function newClientMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `objective-start-${crypto.randomUUID()}`
  return `objective-start-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
