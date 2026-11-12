import { describe, expect, it, vi } from 'vitest'
import type { ObjectiveStartResult } from './agent-objective-start-command'
import type { AgentComposerTaskAttemptMetadata, AgentComposerTaskAttemptPhase } from './agent-composer-task-attempt-store'
import { AgentComposerTaskAttemptStoreError } from './agent-composer-task-attempt-store'
import { startRecoverableComposerTask, consumeAcceptedComposerTaskAttempt, type RecoverableComposerTaskOutcome } from './agent-composer-task-recoverable-start'
import { submitComposerTask } from './agent-composer-task-mode'
import { resolveComposerTaskAvailability } from './agent-composer-task-availability'
import type { AgentComposerTaskRecoveryNoticeState, AgentComposerTaskRecoverySnapshot } from './agent-composer-task-recovery-protocol'

const scopeA = 'a'.repeat(64)
const scopeB = 'b'.repeat(64)
const selected = (sessionId: string) => ({ kind: 'selected-session' as const, sessionId })
const blank = { selectedSessionId: null, composerSessionId: null, hasActiveTurn: false, turnStateReadiness: 'ready' as const,
  sessionStatus: null, isRestoring: false, waitingForAnswer: false, isBusy: false, hasLiveBlocks: false }

function scoped(body: unknown, scope = scopeA): Response {
  return Response.json(body, { headers: { 'X-Account-Scope': scope } })
}

function fakeStore(log: string[], initial: AgentComposerTaskAttemptMetadata | null = null) {
  const rows = new Map<string, AgentComposerTaskAttemptMetadata>()
  if (initial) rows.set(initial.targetSlot, initial)
  const store = {
    list: vi.fn(async (scope: string) => [...rows.values()].filter(row => row.accountScope === scope).map(row => ({ ...row, expired: false }))),
    reserve: vi.fn(async (accountScope: string, target: { kind: 'new-session' } | { kind: 'selected-session'; sessionId: string }, attemptKey: string, createKey?: string) => {
      log.push('reserve')
      const targetSlot = target.kind === 'new-session' ? 'new-session' : JSON.stringify(['session', target.sessionId])
      const existing = rows.get(targetSlot)
      if (existing) {
        return { status: 'existing' as const, attempt: existing, requiresReconciliation: true, expired: false }
      }
      const row: AgentComposerTaskAttemptMetadata = { accountScope, attemptKey, targetSlot,
        targetKind: target.kind, sessionId: target.kind === 'new-session' ? null : target.sessionId,
        createKey: createKey ?? null, phase: 'prepared', createdAt: 1, updatedAt: 1, expiresAt: 1_000 }
      rows.set(targetSlot, row)
      return { status: 'created' as const, attempt: row, requiresReconciliation: false, expired: false }
    }),
    advance: vi.fn(async (_scope: string, _key: string, phase: AgentComposerTaskAttemptPhase) => {
      log.push(`phase:${phase}`)
      const entry = [...rows.entries()].find(([, row]) => row.attemptKey === _key)
      if (!entry) throw new Error('missing reservation')
      const updated = { ...entry[1], phase }
      rows.set(entry[0], updated)
      return updated
    }),
    bindCreatedSession: vi.fn(async (_scope: string, _key: string, sessionId: string) => {
      log.push(`bind:${sessionId}`)
      const entry = [...rows.entries()].find(([, row]) => row.attemptKey === _key)
      if (!entry) throw new Error('missing reservation')
      const updated = { ...entry[1], targetKind: 'selected-session' as const, sessionId,
        targetSlot: JSON.stringify(['session', sessionId]), phase: 'session-known' as const }
      rows.delete(entry[0]); rows.set(updated.targetSlot, updated)
      return updated
    }),
    removeResolved: vi.fn(async (_scope: string, key: string) => {
      log.push(`remove:${key}`)
      const entry = [...rows.entries()].find(([, row]) => row.attemptKey === key)
      const matched = !!entry && (entry[1].phase === 'accepted' || entry[1].phase === 'abandoned')
      if (matched) rows.delete(entry![0])
      return matched
    }),
    current: (key?: string) => [...rows.values()].find(row => !key || row.attemptKey === key) ?? null,
  }
  return store
}

function readySnapshot(scope: string, attemptKey?: string, state: AgentComposerTaskRecoveryNoticeState = { kind: 'unknown' }): Extract<AgentComposerTaskRecoverySnapshot, { kind: 'ready' }> {
  return { kind: 'ready' as const, accountScope: scope, attempts: attemptKey ? [{ attemptKey, state }] : [] }
}

function successFetcher(log: string[], options: { failStartFor?: string; expectedKey?: string; expectedObjective?: string } = {}): typeof fetch {
  return async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname
    if (path === '/api/agent/objective-start-attempts?limit=20' || path === '/api/agent/objective-start-attempts') {
      log.push('scope')
      return scoped({ accountScope: scopeA, attempts: [] })
    }
    if (path === '/api/agent/sessions' && init?.method === 'POST') {
      log.push('post:create')
      expect(new Headers(init.headers).get('X-Expected-Account-Scope')).toBe(scopeA)
      if (options.expectedKey) expect(new Headers(init.headers).get('Idempotency-Key')).toBe(options.expectedKey)
      if (options.expectedObjective) expect(JSON.parse(String(init.body))).toMatchObject({ goal: options.expectedObjective })
      return scoped({ session: { id: 'session-new' } })
    }
    const start = path.match(/^\/api\/agent\/sessions\/([^/]+)\/start-objective$/)
    if (start && init?.method === 'POST') {
      log.push(`post:start:${decodeURIComponent(start[1]!)}`)
      expect(new Headers(init.headers).get('X-Expected-Account-Scope')).toBe(scopeA)
      if (options.expectedKey) expect(new Headers(init.headers).get('Idempotency-Key')).toBe(options.expectedKey)
      if (options.expectedObjective) expect(JSON.parse(String(init.body))).toMatchObject({
        clientMessageId: options.expectedKey, objective: options.expectedObjective,
        content: [{ type: 'text', text: options.expectedObjective }],
      })
      if (options.failStartFor === decodeURIComponent(start[1]!)) throw new TypeError('Network outcome unknown')
      return scoped({ inputId: 'input-1', turnId: 'turn-1', disposition: 'started', sequence: '1' })
    }
    throw new Error(`Unexpected request: ${path}`)
  }
}

describe('recoverable Composer Task admission', () => {
  it('binds the browser fetch receiver for admission and accepted-marker consumption', async () => {
    const log: string[] = []
    const fetcher = vi.fn(function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      expect(this).toBe(globalThis)
      const path = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname
      if (path === '/api/agent/objective-start-attempts') return Promise.resolve(scoped({ accountScope: scopeA, attempts: [] }))
      if (path === '/api/agent/sessions' && init?.method === 'POST') return Promise.resolve(scoped({ session: { id: 'session-new' } }))
      if (path.endsWith('/start-objective') && init?.method === 'POST') return Promise.resolve(scoped({
        inputId: 'input-1', turnId: 'turn-1', disposition: 'started', sequence: '1',
      }))
      throw new Error(`Unexpected request: ${path}`)
    })
    const store = fakeStore(log)
    const outcome = await startRecoverableComposerTask({ target: { kind: 'new-session' }, objective: 'Find roles', store,
      controller: { load: vi.fn(async () => readySnapshot(scopeA)) }, fetcher: fetcher as unknown as typeof fetch,
      makeAttemptKey: () => 'attempt-1', isCurrent: () => true })
    expect(outcome.kind).toBe('accepted')
    const accepted = outcome as Extract<RecoverableComposerTaskOutcome, { kind: 'accepted' }>
    await expect(consumeAcceptedComposerTaskAttempt({ store, accountScope: accepted.accountScope, attemptKey: accepted.attemptKey,
      fetcher: fetcher as unknown as typeof fetch })).resolves.toBe(true)
    expect(store.removeResolved).toHaveBeenCalledWith(scopeA, 'attempt-1')
    expect(fetcher).toHaveBeenCalled()
  })

  it('commits opaque metadata before both scoped POSTs and binds the Session before start', async () => {
    const log: string[] = []
    const store = fakeStore(log)
    const fetcher = successFetcher(log, { expectedKey: 'attempt-1', expectedObjective: 'Find roles' })
    const controller = { load: vi.fn(async () => readySnapshot(scopeA)) }
    const outcome = await startRecoverableComposerTask({ target: { kind: 'new-session' }, objective: 'Find roles', store,
      controller, fetcher, makeAttemptKey: () => 'attempt-1', isCurrent: () => true })

    expect(outcome.kind).toBe('accepted')
    expect(log.indexOf('reserve')).toBeLessThan(log.indexOf('post:create'))
    expect(log.indexOf('phase:create-requested')).toBeLessThan(log.indexOf('post:create'))
    expect(log.indexOf('bind:session-new')).toBeLessThan(log.indexOf('post:start:session-new'))
    expect(log.indexOf('phase:start-requested')).toBeLessThan(log.indexOf('post:start:session-new'))
    expect(log.indexOf('phase:accepted')).toBeGreaterThan(log.indexOf('post:start:session-new'))
    expect(store.current()?.phase).toBe('accepted')
  })

  it('does not send any POST when durable reservation fails', async () => {
    const posts: string[] = []
    const store = fakeStore([])
    store.reserve.mockRejectedValueOnce(new AgentComposerTaskAttemptStoreError('task_attempt_storage_unavailable', 'IDB unavailable'))
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input)
      if (init?.method === 'POST') posts.push(path)
      return scoped({ accountScope: scopeA, attempts: [] })
    }
    const outcome = await startRecoverableComposerTask({ target: { kind: 'new-session' }, objective: 'Find roles', store,
      controller: { load: vi.fn(async () => readySnapshot(scopeA)) }, fetcher, makeAttemptKey: () => 'attempt-1', isCurrent: () => true })
    expect(outcome).toMatchObject({ kind: 'unavailable', state: { reason: 'storage' } })
    expect(posts).toEqual([])
  })

  it('stops before create if authenticated account scope changes after reservation', async () => {
    let reads = 0
    const posts: string[] = []
    const fetcher: typeof fetch = async (_input, init) => {
      if (init?.method === 'POST') posts.push('POST')
      reads += 1
      const scope = reads > 1 ? scopeB : scopeA
      return scoped({ accountScope: scope, attempts: [] }, scope)
    }
    const outcome = await startRecoverableComposerTask({ target: { kind: 'new-session' }, objective: 'Find roles', store: fakeStore([]),
      controller: { load: vi.fn(async () => readySnapshot(scopeB)) }, fetcher, makeAttemptKey: () => 'attempt-1', isCurrent: () => true })
    expect(outcome.kind).toBe('unavailable')
    expect(posts).toEqual([])
  })

  it('invalidates a pending start when selected-Session generation changes after reserve', async () => {
    const log: string[] = []
    let current = true
    const store = fakeStore(log)
    store.reserve.mockImplementationOnce(async (scope, target, key, createKey) => {
      const result = await fakeStore(log).reserve(scope, target, key, createKey)
      current = false
      return result
    })
    const outcome = await startRecoverableComposerTask({ target: selected('session-a'), objective: 'Find roles', store,
      controller: { load: vi.fn(async () => readySnapshot(scopeA)) }, fetcher: successFetcher(log),
      makeAttemptKey: () => 'attempt-1', isCurrent: () => current })
    expect(outcome).toEqual({ kind: 'stale' })
    expect(log.some(call => call.startsWith('post:'))).toBe(false)
  })

  it('requires a successful durable Session bind before sending start-objective', async () => {
    const log: string[] = []
    const store = fakeStore(log)
    store.bindCreatedSession.mockRejectedValueOnce(new AgentComposerTaskAttemptStoreError('task_attempt_storage_unavailable', 'IDB unavailable'))
    const outcome = await startRecoverableComposerTask({ target: { kind: 'new-session' }, objective: 'Find roles', store,
      controller: { load: vi.fn(async () => readySnapshot(scopeA, 'attempt-1')) }, fetcher: successFetcher(log),
      makeAttemptKey: () => 'attempt-1', isCurrent: () => true })
    expect(outcome.kind).toBe('recovery')
    expect(log).toContain('post:create')
    expect(log.some(call => call.startsWith('post:start:'))).toBe(false)
  })

  it('reconciles an existing marker without replaying create or task start', async () => {
    const log: string[] = []
    const existing: AgentComposerTaskAttemptMetadata = { accountScope: scopeA, attemptKey: 'attempt-original', targetSlot: JSON.stringify(['session', 'session-a']),
      targetKind: 'selected-session', sessionId: 'session-a', createKey: null, phase: 'start-requested', createdAt: 1, updatedAt: 1, expiresAt: 1000 }
    const store = fakeStore(log, existing)
    const controller = { load: vi.fn(async () => readySnapshot(scopeA, existing.attemptKey)) }
    const makeAttemptKey = vi.fn(() => 'must-not-be-used')
    const outcome = await startRecoverableComposerTask({ target: selected('session-a'), objective: 'Changed draft', store,
      controller, fetcher: successFetcher(log), makeAttemptKey, isCurrent: () => true })
    expect(outcome).toMatchObject({ kind: 'recovery', attemptKey: 'attempt-original', state: { kind: 'unknown' } })
    expect(makeAttemptKey).not.toHaveBeenCalled()
    expect(log.some(call => call.startsWith('post:'))).toBe(false)
  })

  it('aliases an uncertain new-Session attempt to its created Session for a later selected-session check', async () => {
    const log: string[] = []
    const store = fakeStore(log)
    const fetcher = successFetcher(log, { failStartFor: 'session-new' })
    const controller = { load: vi.fn(async () => {
      const row = store.current()
      return readySnapshot(scopeA, row?.attemptKey)
    }) }
    const first = await startRecoverableComposerTask({ target: { kind: 'new-session' }, objective: 'Find roles', store, controller,
      fetcher, makeAttemptKey: () => 'attempt-original', isCurrent: () => true })
    const makeAttemptKey = vi.fn(() => 'attempt-replacement')
    const reopened = await startRecoverableComposerTask({ target: selected('session-new'), objective: 'Find roles', store, controller,
      fetcher, makeAttemptKey, isCurrent: () => true })

    expect(first).toMatchObject({ kind: 'recovery', attemptKey: 'attempt-original', state: { kind: 'unknown' } })
    expect(reopened).toMatchObject({ kind: 'recovery', attemptKey: 'attempt-original', state: { kind: 'unknown' } })
    expect(store.current()?.targetKind).toBe('selected-session')
    expect(makeAttemptKey).not.toHaveBeenCalled()
    expect(log.filter(call => call.startsWith('post:'))).toEqual(['post:create', 'post:start:session-new'])
  })

  it('keeps A identity when B succeeds, then routes A retry to read-only recovery', async () => {
    const log: string[] = []
    const store = fakeStore(log)
    const fetcher = successFetcher(log, { failStartFor: 'session-a' })
    const controller = { load: vi.fn(async () => {
      const row = store.current()
      return row ? readySnapshot(scopeA, row.attemptKey) : readySnapshot(scopeA)
    }) }
    const keys = ['attempt-a', 'attempt-b']
    const outcomes: RecoverableComposerTaskOutcome[] = []
    const submit = async (sessionId: string, objective: string) => {
      const result = await submitComposerTask({
        mode: 'task', availability: resolveComposerTaskAvailability({ ...blank, selectedSessionId: sessionId,
          composerSessionId: sessionId, sessionStatus: 'running' }), objectiveDraft: objective, attachedFileCount: 0,
        isBusy: false, selectedSessionId: sessionId, selectedSessionRef: { current: sessionId },
        startRecoverableTask: async (draft, target) => {
          const outcome = await startRecoverableComposerTask({ target, objective: draft, store, controller, fetcher,
            makeAttemptKey: () => keys.shift() ?? 'unused-key', isCurrent: () => true })
          outcomes.push(outcome)
          return outcome
        },
        consumeAcceptedAttempt: async outcome => { await consumeAcceptedComposerTaskAttempt({ store, accountScope: outcome.accountScope,
          attemptKey: outcome.attemptKey, fetcher }) },
        startLockRef: { current: false }, setTaskStartBusy: vi.fn(), setStartBusy: vi.fn(), setAddMenuOpen: vi.fn(),
        waitForSessionSwitch: vi.fn(), turnComposerRef: { current: null }, setChatInput: vi.fn(),
        shouldFollowScrollRef: { current: false }, onSessionRecorded: vi.fn(), notifyInfo: vi.fn(), notifyError: vi.fn(), preserveDraft: vi.fn(),
      })
      return result
    }

    await submit('session-a', 'Objective A')
    await submit('session-b', 'Objective B')
    await submit('session-a', 'Objective A')
    expect(outcomes.map(item => item.kind)).toEqual(['recovery', 'accepted', 'recovery'])
    expect(log.filter(call => call.startsWith('post:start:'))).toEqual(['post:start:session-a', 'post:start:session-b'])
    expect(store.reserve).toHaveBeenNthCalledWith(3, scopeA, selected('session-a'), 'attempt-a', undefined)
    expect(outcomes[2]).toMatchObject({ kind: 'recovery', attemptKey: 'attempt-a', state: { kind: 'unknown' } })
    expect(store.current('attempt-b')).toBeNull()
    expect(store.current('attempt-a')?.phase).toBe('start-requested')
  })
})
