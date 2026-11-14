import { describe, expect, it } from 'vitest'
import { AgentComposerTaskAttemptStore, AgentComposerTaskAttemptStoreError } from './agent-composer-task-attempt-store'

type Row = Record<string, unknown>
type MemoryRequest = {
  result: unknown
  onsuccess: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
}

function request(tx: MemoryTransaction, operation: () => unknown): MemoryRequest {
  const value: MemoryRequest = { result: undefined, onsuccess: null, onerror: null }
  tx.enqueue(() => { value.result = operation(); value.onsuccess?.({} as Event) })
  return value
}

class MemoryDatabase {
  rows = new Map<string, Row>()
  objectStoreNames = { contains: () => true }
  onversionchange: (() => void) | null = null
  private tail: Promise<void> = Promise.resolve()

  close() {}

  transaction(): MemoryTransaction {
    const tx = new MemoryTransaction(this)
    this.tail = this.tail.then(() => tx.execute()).catch(() => undefined)
    return tx
  }
}

class MemoryTransaction {
  oncomplete: ((event: Event) => void) | null = null
  onabort: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  private queue: Array<() => void> = []
  private working = new Map<string, Row>()
  private aborted = false
  private readonly store = new MemoryObjectStore(this)

  constructor(private readonly database: MemoryDatabase) {}

  objectStore() { return this.store }
  enqueue(operation: () => void) { this.queue.push(operation) }
  abort() { this.aborted = true }

  async execute() {
    this.working = new Map([...this.database.rows].map(([key, value]) => [key, structuredClone(value)]))
    await Promise.resolve()
    while (this.queue.length && !this.aborted) {
      this.queue.shift()!()
      await Promise.resolve()
    }
    if (this.aborted) this.onabort?.({} as Event)
    else { this.database.rows = this.working; this.oncomplete?.({} as Event) }
  }

  accountRows(scope: string): Row[] {
    return [...this.working.values()].filter(row => row.accountScope === scope)
  }

  add(value: Row) {
    const id = JSON.stringify([value.accountScope, value.targetSlot])
    if (this.working.has(id)) { this.aborted = true; this.onerror?.({} as Event); return }
    this.working.set(id, structuredClone(value))
  }

  put(value: Row) { this.working.set(JSON.stringify([value.accountScope, value.targetSlot]), structuredClone(value)) }
  delete(key: IDBValidKey) { this.working.delete(JSON.stringify(key)) }
}

class MemoryObjectStore {
  index() { return { getAll: (scope: string) => request(this.tx, () => this.tx.accountRows(scope)) } }
  constructor(private readonly tx: MemoryTransaction) {}
  add(value: Row) { return request(this.tx, () => this.tx.add(value)) }
  put(value: Row) { return request(this.tx, () => this.tx.put(value)) }
  delete(key: IDBValidKey) { return request(this.tx, () => this.tx.delete(key)) }
}

function memoryFactory() {
  const database = new MemoryDatabase()
  const factory = {
    open: () => {
      const opened: { result?: MemoryDatabase; onsuccess?: (event: Event) => void } = {}
      queueMicrotask(() => { opened.result = database; opened.onsuccess?.({} as Event) })
      return opened
    },
  } as unknown as IDBFactory
  return { database, factory }
}

describe('AgentComposerTaskAttemptStore', () => {
  it('fails closed when IndexedDB is unavailable', async () => {
    await expect(new AgentComposerTaskAttemptStore({ indexedDB: undefined }).reserve(
      'account-a', { kind: 'selected-session', sessionId: 'session-a' }, 'attempt-a',
    )).rejects.toMatchObject({ code: 'task_attempt_storage_unavailable' })
  })

  it('atomically reserves one account target across concurrent store instances', async () => {
    const { factory, database } = memoryFactory()
    const first = new AgentComposerTaskAttemptStore({ indexedDB: factory, now: () => 1_000 })
    const second = new AgentComposerTaskAttemptStore({ indexedDB: factory, now: () => 1_000 })
    const target = { kind: 'selected-session' as const, sessionId: 'session-a' }
    const results = await Promise.all([
      first.reserve('account-a', target, 'attempt-a'),
      second.reserve('account-a', target, 'attempt-b'),
    ])
    expect(results.map(result => result.status).sort()).toEqual(['created', 'existing'])
    const created = results.find(result => result.status === 'created')!
    const existing = results.find(result => result.status === 'existing')!
    expect(existing.requiresReconciliation).toBe(true)
    expect(existing.attempt.attemptKey).toBe(created.attempt.attemptKey)
    expect([...database.rows.values()]).toHaveLength(1)
    expect(Object.keys([...database.rows.values()][0]!).sort()).toEqual([
      'accountScope', 'attemptKey', 'createKey', 'createdAt', 'expiresAt', 'phase', 'sessionId', 'targetKind', 'targetSlot', 'updatedAt',
    ])
  })

  it('keeps account partitions separate and does not use accountScope as API authorization', async () => {
    const { factory } = memoryFactory()
    const store = new AgentComposerTaskAttemptStore({ indexedDB: factory, now: () => 2_000 })
    const target = { kind: 'selected-session' as const, sessionId: 'session-a' }
    await store.reserve('account-a', target, 'same-key')
    await store.reserve('account-b', target, 'same-key')
    expect((await store.list('account-a')).map(row => row.attemptKey)).toEqual(['same-key'])
    expect((await store.list('account-b')).map(row => row.attemptKey)).toEqual(['same-key'])
  })

  it('atomically binds a created Session or reports a competing target reservation', async () => {
    const { factory } = memoryFactory()
    const first = new AgentComposerTaskAttemptStore({ indexedDB: factory, now: () => 3_000 })
    const second = new AgentComposerTaskAttemptStore({ indexedDB: factory, now: () => 3_000 })
    await first.reserve('account-a', { kind: 'new-session' }, 'attempt-a', 'create-a')
    await first.advance('account-a', 'attempt-a', 'create-requested')
    const race = await Promise.allSettled([
      first.bindCreatedSession('account-a', 'attempt-a', 'session-created'),
      second.reserve('account-a', { kind: 'selected-session', sessionId: 'session-created' }, 'attempt-b'),
    ])
    const bind = race[0]!, selectedReserve = race[1]!
    expect(selectedReserve.status).toBe('fulfilled')
    if (bind.status === 'fulfilled') {
      expect(selectedReserve.status === 'fulfilled' && selectedReserve.value.status).toBe('existing')
      expect(selectedReserve.status === 'fulfilled' && selectedReserve.value.attempt.attemptKey).toBe('attempt-a')
      expect(bind.value.targetSlot).toBe(JSON.stringify(['session', 'session-created']))
    } else {
      expect(bind.reason).toBeInstanceOf(AgentComposerTaskAttemptStoreError)
      expect(selectedReserve.status === 'fulfilled' && selectedReserve.value.status).toBe('created')
      expect((await first.list('account-a')).map(row => row.attemptKey).sort()).toEqual(['attempt-a', 'attempt-b'])
    }
  })

  it('returns expired reservations for reconciliation and never silently replaces their key', async () => {
    const { factory } = memoryFactory()
    let now = 4_000
    const store = new AgentComposerTaskAttemptStore({ indexedDB: factory, now: () => now })
    const target = { kind: 'selected-session' as const, sessionId: 'session-a' }
    const first = await store.reserve('account-a', target, 'attempt-original')
    now = first.attempt.expiresAt
    const later = await store.reserve('account-a', target, 'attempt-new')
    expect(later).toMatchObject({ status: 'existing', requiresReconciliation: true, expired: true })
    expect(later.attempt.attemptKey).toBe('attempt-original')
    expect((await store.list('account-a'))[0]).toMatchObject({ attemptKey: 'attempt-original', expired: true })
  })

  it('requires terminal server outcomes before removal and preserves only opaque metadata', async () => {
    const { factory, database } = memoryFactory()
    const store = new AgentComposerTaskAttemptStore({ indexedDB: factory, now: () => 5_000 })
    const target = { kind: 'new-session' as const }
    const attempt = await store.reserve('account-a', target, 'attempt-a')
    expect(JSON.stringify(database.rows.values().next().value)).not.toMatch(/objective|context|attachment|credential|prompt/i)
    await expect(store.removeResolved('account-a', 'attempt-a')).rejects.toMatchObject({ code: 'task_attempt_conflict' })
    await store.advance('account-a', 'attempt-a', 'create-requested')
    await store.bindCreatedSession('account-a', 'attempt-a', 'session-a')
    await store.advance('account-a', 'attempt-a', 'start-requested')
    await store.advance('account-a', 'attempt-a', 'accepted')
    await expect(store.advance('account-a', 'attempt-a', 'unknown')).rejects.toMatchObject({ code: 'task_attempt_conflict' })
    await expect(store.removeResolved('account-a', 'attempt-a')).resolves.toBe(true)
    expect(await store.list('account-a')).toEqual([])
    expect(attempt.attempt.createKey).toBe('attempt-a')
  })

  it('accepts authoritative receipts from prepared states but never reverses an abandonment tombstone', async () => {
    const { factory } = memoryFactory()
    const store = new AgentComposerTaskAttemptStore({ indexedDB: factory, now: () => 5_500 })
    await store.reserve('account-a', { kind: 'selected-session', sessionId: 'session-a' }, 'prepared-key')
    await expect(store.advance('account-a', 'prepared-key', 'accepted')).resolves.toMatchObject({ phase: 'accepted' })

    await store.reserve('account-a', { kind: 'selected-session', sessionId: 'session-b' }, 'abandoned-key')
    await store.advance('account-a', 'abandoned-key', 'abandoned')
    await expect(store.advance('account-a', 'abandoned-key', 'accepted')).rejects.toMatchObject({ code: 'task_attempt_conflict' })
  })

  it('allows a new key for an abandoned target only after its local marker is removed', async () => {
    const { factory } = memoryFactory()
    const store = new AgentComposerTaskAttemptStore({ indexedDB: factory, now: () => 5_700 })
    const target = { kind: 'selected-session' as const, sessionId: 'session-a' }
    await store.reserve('account-a', target, 'old-key')
    await store.advance('account-a', 'old-key', 'abandoned')
    await expect(store.reserve('account-a', target, 'new-key')).resolves.toMatchObject({
      status: 'existing', attempt: { attemptKey: 'old-key', phase: 'abandoned' },
    })
    await expect(store.removeResolved('account-a', 'old-key')).resolves.toBe(true)

    await expect(store.reserve('account-a', target, 'new-key')).resolves.toMatchObject({
      status: 'created', attempt: { attemptKey: 'new-key', phase: 'prepared' },
    })
  })

  it('rejects malformed records instead of dropping an unknown attempt', async () => {
    const { factory, database } = memoryFactory()
    const store = new AgentComposerTaskAttemptStore({ indexedDB: factory, now: () => 6_000 })
    database.rows.set(JSON.stringify(['account-a', 'new-session']), {
      accountScope: 'account-a', attemptKey: 'attempt-a', targetSlot: 'new-session', targetKind: 'new-session',
      sessionId: null, createKey: 'create-a', phase: 'unknown', createdAt: 1, updatedAt: 1, expiresAt: 30 * 24 * 60 * 60 * 1000 + 1,
      prompt: 'must not be persisted',
    })
    await expect(store.list('account-a')).rejects.toMatchObject({ code: 'task_attempt_metadata_invalid' })
    await expect(store.reserve('account-a', { kind: 'new-session' }, 'new-key')).rejects.toMatchObject({
      code: 'task_attempt_metadata_invalid',
    })
  })

  it('rejects target objects with fields outside the persisted metadata contract', async () => {
    const { factory } = memoryFactory()
    const store = new AgentComposerTaskAttemptStore({ indexedDB: factory, now: () => 7_000 })
    await expect(store.reserve('account-a', {
      kind: 'selected-session', sessionId: 'session-a', objective: 'private task text',
    } as never, 'attempt-a')).rejects.toMatchObject({ code: 'task_attempt_metadata_invalid' })
  })
})
