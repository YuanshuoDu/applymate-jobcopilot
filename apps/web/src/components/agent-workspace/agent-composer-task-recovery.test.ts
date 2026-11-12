import { describe, expect, it, vi } from 'vitest'
import type { AgentComposerTaskAttemptMetadata } from './agent-composer-task-attempt-store'
import { AgentComposerTaskRecoveryController } from './agent-composer-task-recovery'

const scopeA = 'a'.repeat(64)
const scopeB = 'b'.repeat(64)
const attemptKey = 'attempt-1'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function response(body: unknown, scope: string, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'X-Account-Scope': scope } })
}

function row(scope = scopeA, phase: AgentComposerTaskAttemptMetadata['phase'] = 'start-requested', createKey: string | null = null): AgentComposerTaskAttemptMetadata {
  return { accountScope: scope, attemptKey, targetSlot: JSON.stringify(['session', 'session-1']), targetKind: 'selected-session',
    sessionId: 'session-1', createKey, phase, createdAt: 1, updatedAt: 1, expiresAt: 1000 }
}

function fakeStore(initial: AgentComposerTaskAttemptMetadata) {
  let current = initial
  let removed = false
  return {
    store: {
      list: vi.fn(async (scope: string) => scope === initial.accountScope && !removed ? [{ ...current, expired: false }] : []),
      advance: vi.fn(async (_scope: string, _key: string, phase: AgentComposerTaskAttemptMetadata['phase']) => {
        current = { ...current, phase }
        return current
      }),
      bindCreatedSession: vi.fn(async (_scope: string, _key: string, sessionId: string) => {
        current = { ...current, targetKind: 'selected-session', sessionId, targetSlot: JSON.stringify(['session', sessionId]), phase: 'session-known' }
        return current
      }),
      removeResolved: vi.fn(async () => { removed = true; return true }),
    },
  }
}

function fakeFetcher(state: 'accepted' | 'unknown' | 'abandoned' | 'unavailable', calls: Array<{ path: string; init?: RequestInit }>, scope = scopeA): typeof fetch {
  return async (input, init) => {
    const path = String(input)
    calls.push({ path, init })
    if (path.includes('?limit=20')) return response({ accountScope: scope, attempts: [] }, scope)
    if (path.endsWith('/abandon')) return response({ accountScope: scope, state: 'abandoned' }, scope)
    if (path.includes('/objective-start-attempts/')) {
      if (state === 'accepted') return response({ accountScope: scope, state, receipt: {
        sessionId: 'session-1', inputId: 'input-1', turnId: 'turn-1', sequence: '1',
      } }, scope)
      return response({ accountScope: scope, state }, scope)
    }
    throw new Error(`Unexpected recovery request: ${path}`)
  }
}

describe('AgentComposerTaskRecoveryController', () => {
  it('binds the injected fetch receiver before calling it as a controller method', async () => {
    const fetcher = vi.fn(function (this: unknown, input: RequestInfo | URL) {
      expect(this).toBe(globalThis)
      const path = String(input)
      const body = path.includes('?limit=20') ? { accountScope: scopeA, attempts: [] } : { accountScope: scopeA, state: 'unknown' }
      return Promise.resolve(response(body, scopeA))
    })
    const controller = new AgentComposerTaskRecoveryController({ fetcher: fetcher as unknown as typeof fetch, store: fakeStore(row()).store })

    await expect(controller.load()).resolves.toMatchObject({ kind: 'ready' })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('opens only a reconciled accepted receipt and removes its matching local marker', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    const storage = fakeStore(row())
    const controller = new AgentComposerTaskRecoveryController({ fetcher: fakeFetcher('accepted', calls), store: storage.store })
    expect((await controller.load()).kind).toBe('ready')
    const open = vi.fn()

    await expect(controller.openAccepted(attemptKey, open)).resolves.toBe('opened')

    expect(open).toHaveBeenCalledWith('session-1', 'turn-1')
    expect(storage.store.removeResolved).toHaveBeenCalledWith(scopeA, attemptKey)
    expect(calls.some(call => call.path.includes('/sessions') || call.path.includes('/start-objective'))).toBe(false)
  })

  it('consumes an accepted marker before an open callback can reload the controller', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    const storage = fakeStore(row(scopeA, 'accepted'))
    const remove = storage.store.removeResolved
    const order: string[] = []
    storage.store.removeResolved = vi.fn(async () => { order.push('remove'); return remove() })
    const controller = new AgentComposerTaskRecoveryController({ fetcher: fakeFetcher('accepted', calls), store: storage.store })
    await controller.load()
    const open = vi.fn(async () => { order.push('open'); await controller.load() })

    await expect(controller.openAccepted(attemptKey, open)).resolves.toBe('opened')

    expect(order).toEqual(['remove', 'open'])
    expect(storage.store.removeResolved).toHaveBeenCalledWith(scopeA, attemptKey)
    await expect(controller.load()).resolves.toMatchObject({ kind: 'ready', attempts: [] })
  })

  it('keeps a consumed marker cleared when the local open callback fails', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    const storage = fakeStore(row(scopeA, 'accepted'))
    const controller = new AgentComposerTaskRecoveryController({ fetcher: fakeFetcher('accepted', calls), store: storage.store })
    await controller.load()

    await expect(controller.openAccepted(attemptKey, () => { throw new Error('Navigation failed') })).resolves.toBe('consumed')

    expect(storage.store.removeResolved).toHaveBeenCalledWith(scopeA, attemptKey)
    await expect(controller.load()).resolves.toMatchObject({ kind: 'ready', attempts: [] })
    expect(calls.some(call => call.path.includes('/sessions') || call.path.includes('/start-objective'))).toBe(false)
  })

  it('rejects a duplicate accepted open while the first callback is pending', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    const storage = fakeStore(row(scopeA, 'accepted'))
    const controller = new AgentComposerTaskRecoveryController({ fetcher: fakeFetcher('accepted', calls), store: storage.store })
    await controller.load()
    let beginOpen!: () => void
    let finishOpen!: () => void
    const openStarted = new Promise<void>(resolve => { beginOpen = resolve })
    const waitForOpen = new Promise<void>(resolve => { finishOpen = resolve })
    const open = vi.fn(async () => { beginOpen(); await waitForOpen })
    const first = controller.openAccepted(attemptKey, open)
    await openStarted

    await expect(controller.openAccepted(attemptKey, vi.fn())).resolves.toBe(false)
    finishOpen()
    await expect(first).resolves.toBe('opened')
    expect(open).toHaveBeenCalledTimes(1)
    expect(storage.store.removeResolved).toHaveBeenCalledTimes(1)
  })

  it('locks accepted receipt evidence from prepared and session-known local attempts', async () => {
    for (const phase of ['prepared', 'session-known'] as const) {
      const calls: Array<{ path: string; init?: RequestInit }> = []
      const storage = fakeStore(row(scopeA, phase))
      const controller = new AgentComposerTaskRecoveryController({ fetcher: fakeFetcher('accepted', calls), store: storage.store })
      const snapshot = await controller.load()

      expect(snapshot).toMatchObject({ kind: 'ready', attempts: [{ attemptKey, state: { kind: 'accepted' } }] })
      await expect(controller.openAccepted(attemptKey, vi.fn())).resolves.toBe('opened')
      expect(storage.store.advance).toHaveBeenCalledWith(scopeA, attemptKey, 'accepted')
      expect(storage.store.removeResolved).toHaveBeenCalledWith(scopeA, attemptKey)
    }
  })

  it('does not open an Account A receipt after a concurrent load switches the controller to Account B', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    const storage = fakeStore(row())
    let switching = false
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input)
      calls.push({ path, init })
      if (path.includes('?limit=20')) {
        const scope = switching ? scopeB : scopeA
        return response({ accountScope: scope, attempts: [] }, scope)
      }
      if (path.includes('/objective-start-attempts/')) return response({ accountScope: scopeA, state: 'accepted', receipt: {
        sessionId: 'session-1', inputId: 'input-1', turnId: 'turn-1', sequence: '1',
      } }, scopeA)
      throw new Error(`Unexpected recovery request: ${path}`)
    }
    const controller = new AgentComposerTaskRecoveryController({ fetcher, store: storage.store })
    await controller.load()
    const originalCheck = controller.check.bind(controller)
    let switchAccount: Promise<unknown> | undefined
    vi.spyOn(controller, 'check').mockImplementation(async key => {
      const accepted = await originalCheck(key)
      switching = true
      switchAccount = controller.load()
      return accepted
    })
    const open = vi.fn()

    await expect(controller.openAccepted(attemptKey, open)).resolves.toBe(false)
    await switchAccount

    expect(open).not.toHaveBeenCalled()
    expect(storage.store.removeResolved).not.toHaveBeenCalled()
  })

  it('does not cache a deferred Account A store lookup after Account B becomes current', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    const pendingRows = deferred<readonly (AgentComposerTaskAttemptMetadata & { expired: boolean })[]>()
    const listStarted = deferred<void>()
    let accountScope = scopeA, accountALists = 0
    const storage = {
      list: vi.fn(async (scope: string) => {
        if (scope === scopeA && accountALists++ === 0) return []
        if (scope === scopeA) { listStarted.resolve(); return pendingRows.promise }
        return []
      }),
      advance: vi.fn(async () => row()),
      bindCreatedSession: vi.fn(async () => row()),
      removeResolved: vi.fn(async () => true),
    }
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input)
      calls.push({ path, init })
      if (path.includes('?limit=20')) return response({ accountScope, attempts: [] }, accountScope)
      if (path.includes('/objective-start-attempts/')) return response({ accountScope, state: 'unknown' }, accountScope)
      throw new Error(`Unexpected recovery request: ${path}`)
    }
    const controller = new AgentComposerTaskRecoveryController({ fetcher, store: storage })
    await expect(controller.load()).resolves.toMatchObject({ kind: 'ready', accountScope: scopeA, attempts: [] })
    const accountACheck = controller.check(attemptKey)
    await listStarted.promise
    accountScope = scopeB
    await expect(controller.load()).resolves.toMatchObject({ kind: 'ready', accountScope: scopeB, attempts: [] })
    pendingRows.resolve([{ ...row(scopeA), expired: false }])

    await expect(accountACheck).resolves.toEqual({ kind: 'unavailable', reason: 'error' })
    await expect(controller.check(attemptKey)).resolves.toEqual({ kind: 'unavailable', reason: 'storage' })
    expect(storage.advance).not.toHaveBeenCalled()
  })

  it('does not cache a deferred Account A phase write after Account B becomes current', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    const pendingAdvance = deferred<AgentComposerTaskAttemptMetadata>()
    const advanceStarted = deferred<void>()
    let accountScope = scopeA
    const storage = {
      list: vi.fn(async (scope: string) => scope === scopeA ? [{ ...row(scopeA), expired: false }] : []),
      advance: vi.fn(async (scope: string, _key: string, phase: AgentComposerTaskAttemptMetadata['phase']) => {
        if (scope === scopeA && phase === 'accepted') { advanceStarted.resolve(); return pendingAdvance.promise }
        return { ...row(scope), phase }
      }),
      bindCreatedSession: vi.fn(async (_scope: string, _key: string, sessionId: string) => row(scopeA, 'session-known')),
      removeResolved: vi.fn(async () => true),
    }
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input)
      calls.push({ path, init })
      if (path.includes('?limit=20')) return response({ accountScope, attempts: [] }, accountScope)
      if (path.includes('/objective-start-attempts/')) return response({ accountScope, state: 'accepted', receipt: {
        sessionId: 'session-1', inputId: 'input-1', turnId: 'turn-1', sequence: '1',
      } }, accountScope)
      throw new Error(`Unexpected recovery request: ${path}`)
    }
    const controller = new AgentComposerTaskRecoveryController({ fetcher, store: storage })
    const accountALoad = controller.load()
    await advanceStarted.promise
    accountScope = scopeB
    await expect(controller.load()).resolves.toMatchObject({ kind: 'ready', accountScope: scopeB, attempts: [] })
    pendingAdvance.resolve({ ...row(scopeA), phase: 'accepted' })

    await expect(accountALoad).resolves.toMatchObject({ kind: 'unavailable', reason: 'error' })
    await expect(controller.check(attemptKey)).resolves.toEqual({ kind: 'unavailable', reason: 'storage' })
    expect(storage.advance.mock.calls.every(([scope]) => scope === scopeA)).toBe(true)
  })

  it('abandons only after a fresh unknown receipt and never creates or starts a task', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    const storage = fakeStore(row())
    const controller = new AgentComposerTaskRecoveryController({ fetcher: fakeFetcher('unknown', calls), store: storage.store })
    await controller.load()

    await expect(controller.abandon(attemptKey)).resolves.toMatchObject({ kind: 'abandoned' })

    const abandon = calls.find(call => call.path.endsWith('/abandon'))
    expect(abandon?.init?.method).toBe('POST')
    expect(abandon?.init?.body).toBeUndefined()
    expect(calls.some(call => call.path.endsWith('/sessions') || call.path.includes('/start-objective'))).toBe(false)
  })

  it('clears a local marker only after rechecking the server abandonment tombstone', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    const storage = fakeStore(row())
    let serverState: 'unknown' | 'abandoned' = 'unknown'
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input)
      calls.push({ path, init })
      if (path.includes('?limit=20')) return response({ accountScope: scopeA, attempts: [] }, scopeA)
      if (path.endsWith('/abandon')) {
        serverState = 'abandoned'
        return response({ accountScope: scopeA, state: serverState }, scopeA)
      }
      if (path.includes('/objective-start-attempts/')) return response({ accountScope: scopeA, state: serverState }, scopeA)
      throw new Error(`Unexpected recovery request: ${path}`)
    }
    const controller = new AgentComposerTaskRecoveryController({ fetcher, store: storage.store })
    await controller.load()

    await expect(controller.abandon(attemptKey)).resolves.toMatchObject({ kind: 'abandoned' })
    await expect(controller.removeRecoveryNotice(attemptKey)).resolves.toBe(true)

    expect(storage.store.removeResolved).toHaveBeenCalledWith(scopeA, attemptKey)
    await expect(storage.store.list(scopeA)).resolves.toEqual([])
    expect(calls.filter(call => call.path.endsWith('/abandon'))).toHaveLength(1)
  })

  it('keeps accepted-but-deleted targets distinct from unknown and only removes a confirmed local marker', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    const storage = fakeStore(row('a'.repeat(64), 'accepted'))
    const controller = new AgentComposerTaskRecoveryController({ fetcher: fakeFetcher('unavailable', calls), store: storage.store })
    await controller.load()

    await expect(controller.check(attemptKey)).resolves.toEqual({ kind: 'unavailable', reason: 'accepted-target-missing' })
    await expect(controller.removeRecoveryNotice(attemptKey)).resolves.toBe(true)

    expect(calls.some(call => call.path.endsWith('/abandon'))).toBe(false)
    expect(storage.store.removeResolved).toHaveBeenCalledWith(scopeA, attemptKey)
  })

  it('promotes session-known local metadata to accepted evidence before removing an unavailable target marker', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    const storage = fakeStore(row(scopeA, 'session-known'))
    const controller = new AgentComposerTaskRecoveryController({ fetcher: fakeFetcher('unavailable', calls), store: storage.store })

    await expect(controller.load()).resolves.toMatchObject({
      kind: 'ready', attempts: [{ attemptKey, state: { kind: 'unavailable', reason: 'accepted-target-missing' } }],
    })
    await expect(controller.removeRecoveryNotice(attemptKey)).resolves.toBe(true)

    expect(storage.store.advance).toHaveBeenCalledWith(scopeA, attemptKey, 'accepted')
    expect(calls.some(call => call.path.endsWith('/abandon'))).toBe(false)
  })

  it('fails closed when the server contradicts a local abandonment tombstone', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    const storage = fakeStore(row(scopeA, 'abandoned'))
    const controller = new AgentComposerTaskRecoveryController({ fetcher: fakeFetcher('accepted', calls), store: storage.store })

    await expect(controller.load()).resolves.toMatchObject({
      kind: 'ready', attempts: [{ attemptKey, state: { kind: 'unavailable', reason: 'error' } }],
    })
    expect(storage.store.advance).not.toHaveBeenCalled()
    expect(storage.store.removeResolved).not.toHaveBeenCalled()
  })
})
