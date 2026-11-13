export const MAX_ATTEMPTS_PER_ACCOUNT = 32
export const MAX_ATTEMPT_AGE_MS = 30 * 24 * 60 * 60 * 1000

const DATABASE_NAME = 'applymate-agent-task-attempts-v1'
const DATABASE_VERSION = 1
const STORE_NAME = 'attempts'
const ACCOUNT_INDEX = 'byAccountScope'
const ACCOUNT_ATTEMPT_INDEX = 'byAccountAttempt'

export type AgentComposerTaskAttemptPhase =
  | 'prepared' | 'create-requested' | 'session-known' | 'start-requested'
  | 'unknown' | 'accepted' | 'abandoned'

export type AgentComposerTaskAttemptMetadata = Readonly<{
  accountScope: string
  attemptKey: string
  targetSlot: string
  targetKind: 'new-session' | 'selected-session'
  sessionId: string | null
  createKey: string | null
  phase: AgentComposerTaskAttemptPhase
  createdAt: number
  updatedAt: number
  expiresAt: number
}>

export class AgentComposerTaskAttemptStoreError extends Error {
  readonly code: 'task_attempt_storage_unavailable' | 'task_attempt_metadata_invalid' | 'task_attempt_limit' | 'task_attempt_conflict'

  constructor(code: AgentComposerTaskAttemptStoreError['code'], message: string) {
    super(message)
    this.name = 'AgentComposerTaskAttemptStoreError'
    this.code = code
  }
}

export type AgentComposerTaskAttemptEffects<T> = Readonly<{
  result: T
  add?: readonly AgentComposerTaskAttemptMetadata[]
  put?: readonly AgentComposerTaskAttemptMetadata[]
  delete?: readonly IDBValidKey[]
}>
export type AgentComposerTaskAttemptWork<T> = (records: readonly AgentComposerTaskAttemptMetadata[]) => AgentComposerTaskAttemptEffects<T>

export function attemptTargetSlot(targetKind: AgentComposerTaskAttemptMetadata['targetKind'], sessionId: string | null): string {
  return targetKind === 'new-session' ? 'new-session' : JSON.stringify(['session', sessionId])
}

export function isSafeAttemptOpaqueId(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && /^[!-~]+$/.test(value)
}

export function assertAccountScope(value: unknown): asserts value is string {
  if (!isSafeAttemptOpaqueId(value, 256)) throw metadataError('Authenticated account scope is invalid.')
}

export function assertAttemptKey(value: unknown): asserts value is string {
  if (!isSafeAttemptOpaqueId(value, 128)) throw metadataError('Task attempt key is invalid.')
}

function isPhase(value: unknown): value is AgentComposerTaskAttemptPhase {
  return value === 'prepared' || value === 'create-requested' || value === 'session-known'
    || value === 'start-requested' || value === 'unknown' || value === 'accepted' || value === 'abandoned'
}

export function validateTaskAttemptRows(rows: unknown, scope: string): AgentComposerTaskAttemptMetadata[] {
  if (!Array.isArray(rows) || rows.length > MAX_ATTEMPTS_PER_ACCOUNT) {
    throw new AgentComposerTaskAttemptStoreError('task_attempt_limit', 'Task recovery metadata exceeds its safe account limit.')
  }
  const fields = ['accountScope', 'attemptKey', 'targetSlot', 'targetKind', 'sessionId', 'createKey', 'phase', 'createdAt', 'updatedAt', 'expiresAt'].sort().join('|')
  const result: AgentComposerTaskAttemptMetadata[] = [], keys = new Set<string>(), slots = new Set<string>()
  for (const value of rows) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw metadataError('Stored task recovery metadata is invalid.')
    const row = value as Record<string, unknown>
    if (Object.keys(row).sort().join('|') !== fields || row.accountScope !== scope
      || !isSafeAttemptOpaqueId(row.attemptKey, 128) || !isPhase(row.phase)
      || (row.targetKind !== 'new-session' && row.targetKind !== 'selected-session')) {
      throw metadataError('Stored task recovery metadata is invalid.')
    }
    const targetValid = row.targetKind === 'new-session'
      ? row.sessionId === null && isSafeAttemptOpaqueId(row.createKey, 128)
      : isSafeAttemptOpaqueId(row.sessionId, 256)
    if (!targetValid) {
      throw metadataError('Stored task recovery target is invalid.')
    }
    if (row.createKey !== null && !isSafeAttemptOpaqueId(row.createKey, 128)) throw metadataError('Stored task recovery key is invalid.')
    if (row.targetSlot !== attemptTargetSlot(row.targetKind, row.sessionId as string | null)
      || ![row.createdAt, row.updatedAt, row.expiresAt].every(n => Number.isSafeInteger(n) && (n as number) >= 0)
      || (row.updatedAt as number) < (row.createdAt as number)
      || row.expiresAt !== (row.createdAt as number) + MAX_ATTEMPT_AGE_MS
      || keys.has(row.attemptKey) || slots.has(row.targetSlot)) {
      throw metadataError('Stored task recovery metadata is invalid.')
    }
    keys.add(row.attemptKey)
    slots.add(row.targetSlot)
    result.push(row as AgentComposerTaskAttemptMetadata)
  }
  return result
}

function metadataError(message: string): AgentComposerTaskAttemptStoreError {
  return new AgentComposerTaskAttemptStoreError('task_attempt_metadata_invalid', message)
}

function openDatabase(factory?: IDBFactory): Promise<IDBDatabase> {
  const source = factory ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB)
  if (!source) return Promise.reject(new AgentComposerTaskAttemptStoreError('task_attempt_storage_unavailable', 'Task recovery storage is unavailable.'))
  return new Promise((resolve, reject) => {
    const request = source.open(DATABASE_NAME, DATABASE_VERSION)
    let settled = false
    const rejectOpen = () => {
      if (settled) return
      settled = true
      reject(new AgentComposerTaskAttemptStoreError('task_attempt_storage_unavailable', 'Task recovery storage could not be opened.'))
    }
    request.onupgradeneeded = () => {
      try {
        const db = request.result
        const store = db.objectStoreNames.contains(STORE_NAME)
          ? request.transaction!.objectStore(STORE_NAME)
          : db.createObjectStore(STORE_NAME, { keyPath: ['accountScope', 'targetSlot'] })
        if (!store.indexNames.contains(ACCOUNT_INDEX)) store.createIndex(ACCOUNT_INDEX, 'accountScope')
        if (!store.indexNames.contains(ACCOUNT_ATTEMPT_INDEX)) store.createIndex(ACCOUNT_ATTEMPT_INDEX, ['accountScope', 'attemptKey'], { unique: true })
      } catch { request.transaction?.abort(); rejectOpen() }
    }
    request.onerror = rejectOpen
    request.onblocked = rejectOpen
    request.onsuccess = () => {
      const db = request.result
      if (settled) { db.close(); return }
      settled = true
      db.onversionchange = () => db.close()
      resolve(db)
    }
  })
}

export function transactTaskAttemptAccount<T>(scope: string, mode: IDBTransactionMode,
  work: AgentComposerTaskAttemptWork<T>, factory?: IDBFactory): Promise<T> {
  return openDatabase(factory).then(db => new Promise((resolve, reject) => {
    let tx: IDBTransaction
    try { tx = db.transaction(STORE_NAME, mode) } catch {
      db.close()
      reject(new AgentComposerTaskAttemptStoreError('task_attempt_storage_unavailable', 'Task recovery storage transaction could not start.'))
      return
    }
    let output: T, hasOutput = false
    let problem: Error | undefined
    const fail = (error: Error) => { problem = error; try { tx.abort() } catch { /* transaction already ended */ } }
    tx.oncomplete = () => { db.close(); hasOutput ? resolve(output) : reject(problem ?? new AgentComposerTaskAttemptStoreError('task_attempt_storage_unavailable', 'Task recovery transaction did not complete.')) }
    tx.onerror = () => { problem ??= new AgentComposerTaskAttemptStoreError('task_attempt_storage_unavailable', 'Task recovery storage failed.') }
    tx.onabort = () => { db.close(); reject(problem ?? new AgentComposerTaskAttemptStoreError('task_attempt_storage_unavailable', 'Task recovery storage transaction was aborted.')) }
    try {
      const store = tx.objectStore(STORE_NAME)
      const request = store.index(ACCOUNT_INDEX).getAll(scope)
      request.onerror = () => { problem ??= new AgentComposerTaskAttemptStoreError('task_attempt_storage_unavailable', 'Task recovery metadata could not be read.') }
      request.onsuccess = () => {
        try {
          const effects = work(validateTaskAttemptRows(request.result, scope))
          output = effects.result
          hasOutput = true
          for (const slot of effects.delete ?? []) store.delete(slot)
          for (const item of effects.put ?? []) store.put(item)
          for (const item of effects.add ?? []) store.add(item)
        } catch (error) {
          fail(error instanceof AgentComposerTaskAttemptStoreError ? error
            : new AgentComposerTaskAttemptStoreError('task_attempt_storage_unavailable', 'Task recovery storage operation failed.'))
        }
      }
    } catch (error) {
      fail(error instanceof AgentComposerTaskAttemptStoreError ? error
        : new AgentComposerTaskAttemptStoreError('task_attempt_storage_unavailable', 'Task recovery storage operation failed.'))
    }
  }))
}
