import {
  MAX_ATTEMPTS_PER_ACCOUNT,
  MAX_ATTEMPT_AGE_MS,
  AgentComposerTaskAttemptStoreError,
  assertAccountScope,
  assertAttemptKey,
  attemptTargetSlot,
  isSafeAttemptOpaqueId,
  transactTaskAttemptAccount,
  type AgentComposerTaskAttemptMetadata,
  type AgentComposerTaskAttemptPhase,
} from './agent-composer-task-attempt-store-idb'

export { AgentComposerTaskAttemptStoreError }
export type { AgentComposerTaskAttemptMetadata, AgentComposerTaskAttemptPhase }

export type AgentComposerTaskTarget =
  | Readonly<{ kind: 'new-session' }>
  | Readonly<{ kind: 'selected-session'; sessionId: string }>

export type AgentComposerTaskAttemptReservation = Readonly<{
  status: 'created' | 'existing'
  attempt: AgentComposerTaskAttemptMetadata
  requiresReconciliation: boolean
  expired: boolean
}>
export type AgentComposerTaskAttemptView = AgentComposerTaskAttemptMetadata & Readonly<{ expired: boolean }>

type TargetInfo = Readonly<{
  targetKind: AgentComposerTaskAttemptMetadata['targetKind']
  sessionId: string | null
  slot: string
}>

function parseTarget(target: AgentComposerTaskTarget): TargetInfo {
  if (!target || typeof target !== 'object') throw new AgentComposerTaskAttemptStoreError('task_attempt_metadata_invalid', 'Task target is invalid.')
  const keys = Object.keys(target).sort().join('|')
  if (target.kind === 'new-session' && keys === 'kind') return { targetKind: target.kind, sessionId: null, slot: 'new-session' }
  if (target.kind === 'selected-session' && keys === 'kind|sessionId' && isSafeAttemptOpaqueId(target.sessionId, 256)) {
    return { targetKind: target.kind, sessionId: target.sessionId, slot: attemptTargetSlot(target.kind, target.sessionId) }
  }
  throw new AgentComposerTaskAttemptStoreError('task_attempt_metadata_invalid', 'Task target is invalid.')
}

function timestamp(now: () => number): number {
  const value = now()
  if (!Number.isSafeInteger(value) || value < 0 || value + MAX_ATTEMPT_AGE_MS > Number.MAX_SAFE_INTEGER) {
    throw new AgentComposerTaskAttemptStoreError('task_attempt_metadata_invalid', 'Task recovery timestamp is invalid.')
  }
  return value
}

const TRANSITIONS: Record<AgentComposerTaskAttemptPhase, readonly AgentComposerTaskAttemptPhase[]> = {
  prepared: ['create-requested', 'start-requested', 'accepted', 'abandoned'],
  'create-requested': ['session-known', 'unknown', 'accepted', 'abandoned'],
  'session-known': ['start-requested', 'unknown', 'accepted', 'abandoned'],
  'start-requested': ['accepted', 'unknown', 'abandoned'],
  unknown: ['session-known', 'accepted', 'abandoned'],
  accepted: [], abandoned: [],
}

/** Opaque recovery metadata only. accountScope partitions local rows; it never authorizes API requests. */
export class AgentComposerTaskAttemptStore {
  private readonly factory?: IDBFactory
  private readonly now: () => number

  constructor(options: { indexedDB?: IDBFactory; now?: () => number } = {}) {
    this.factory = options.indexedDB
    this.now = options.now ?? Date.now
  }

  async list(accountScope: string): Promise<readonly AgentComposerTaskAttemptView[]> {
    assertAccountScope(accountScope)
    const now = timestamp(this.now)
    return transactTaskAttemptAccount<readonly AgentComposerTaskAttemptView[]>(accountScope, 'readonly', rows => ({
      result: [...rows].sort((a, b) => b.updatedAt - a.updatedAt).map(row => ({ ...row, expired: now >= row.expiresAt })),
    }), this.factory)
  }

  async reserve(accountScope: string, target: AgentComposerTaskTarget, attemptKey: string,
    createKey?: string): Promise<AgentComposerTaskAttemptReservation> {
    assertAccountScope(accountScope); assertAttemptKey(attemptKey)
    const parsed = parseTarget(target)
    const effectiveCreateKey = parsed.targetKind === 'new-session' ? (createKey ?? attemptKey) : null
    if (effectiveCreateKey !== null) assertAttemptKey(effectiveCreateKey)
    if (parsed.targetKind === 'selected-session' && createKey !== undefined) {
      throw new AgentComposerTaskAttemptStoreError('task_attempt_metadata_invalid', 'Selected Session attempts cannot carry a creation key.')
    }
    const createdAt = timestamp(this.now)
    return transactTaskAttemptAccount<AgentComposerTaskAttemptReservation>(accountScope, 'readwrite', rows => {
      const existing = rows.find(row => row.targetSlot === parsed.slot)
      if (existing) return { result: { status: 'existing', attempt: existing, requiresReconciliation: true,
        expired: createdAt >= existing.expiresAt } }
      if (rows.some(row => row.attemptKey === attemptKey)) {
        throw new AgentComposerTaskAttemptStoreError('task_attempt_conflict', 'Task attempt key is already assigned to another target.')
      }
      if (rows.length >= MAX_ATTEMPTS_PER_ACCOUNT) {
        throw new AgentComposerTaskAttemptStoreError('task_attempt_limit', 'Task recovery metadata account limit has been reached.')
      }
      const attempt: AgentComposerTaskAttemptMetadata = { accountScope, attemptKey, targetSlot: parsed.slot,
        targetKind: parsed.targetKind, sessionId: parsed.sessionId, createKey: effectiveCreateKey,
        phase: 'prepared', createdAt, updatedAt: createdAt, expiresAt: createdAt + MAX_ATTEMPT_AGE_MS }
      return { result: { status: 'created', attempt, requiresReconciliation: false, expired: false }, add: [attempt] }
    }, this.factory)
  }

  /** Atomically aliases a new-session reservation to its created Session slot. */
  async bindCreatedSession(accountScope: string, attemptKey: string, sessionId: string): Promise<AgentComposerTaskAttemptMetadata> {
    assertAccountScope(accountScope); assertAttemptKey(attemptKey)
    if (!isSafeAttemptOpaqueId(sessionId, 256)) {
      throw new AgentComposerTaskAttemptStoreError('task_attempt_metadata_invalid', 'Created Session ID is invalid.')
    }
    const slot = attemptTargetSlot('selected-session', sessionId), updatedAt = timestamp(this.now)
    return transactTaskAttemptAccount<AgentComposerTaskAttemptMetadata>(accountScope, 'readwrite', rows => {
      const current = rows.find(row => row.attemptKey === attemptKey)
      if (!current) throw new AgentComposerTaskAttemptStoreError('task_attempt_conflict', 'Task attempt is no longer stored.')
      if (current.targetKind === 'selected-session' && current.sessionId === sessionId) return { result: current }
      if (current.targetKind !== 'new-session' || !['create-requested', 'unknown'].includes(current.phase)) {
        throw new AgentComposerTaskAttemptStoreError('task_attempt_conflict', 'Task attempt cannot be bound to this Session.')
      }
      if (rows.some(row => row.targetSlot === slot && row.attemptKey !== attemptKey)) {
        throw new AgentComposerTaskAttemptStoreError('task_attempt_conflict', 'Another unresolved attempt already owns this Session.')
      }
      const attempt = { ...current, targetKind: 'selected-session' as const, sessionId, targetSlot: slot,
        phase: 'session-known' as const, updatedAt: Math.max(updatedAt, current.updatedAt) }
      return { result: attempt, delete: [[accountScope, current.targetSlot]], add: [attempt] }
    }, this.factory)
  }

  async advance(accountScope: string, attemptKey: string, phase: AgentComposerTaskAttemptPhase): Promise<AgentComposerTaskAttemptMetadata> {
    assertAccountScope(accountScope); assertAttemptKey(attemptKey)
    if (!Object.hasOwn(TRANSITIONS, phase)) throw new AgentComposerTaskAttemptStoreError('task_attempt_metadata_invalid', 'Task attempt phase is invalid.')
    const updatedAt = timestamp(this.now)
    return transactTaskAttemptAccount<AgentComposerTaskAttemptMetadata>(accountScope, 'readwrite', rows => {
      const current = rows.find(row => row.attemptKey === attemptKey)
      if (!current) throw new AgentComposerTaskAttemptStoreError('task_attempt_conflict', 'Task attempt is no longer stored.')
      if (current.phase === phase) return { result: current }
      if (phase === 'session-known' || phase === 'create-requested' && current.targetKind !== 'new-session'
        || phase === 'start-requested' && current.targetKind !== 'selected-session') {
        throw new AgentComposerTaskAttemptStoreError('task_attempt_conflict', 'Task attempt phase does not match its Session target.')
      }
      if (!TRANSITIONS[current.phase].includes(phase)) {
        throw new AgentComposerTaskAttemptStoreError('task_attempt_conflict', 'Task attempt phase transition is not allowed.')
      }
      const attempt = { ...current, phase, updatedAt: Math.max(updatedAt, current.updatedAt) }
      return { result: attempt, put: [attempt] }
    }, this.factory)
  }

  async removeResolved(accountScope: string, attemptKey: string): Promise<boolean> {
    assertAccountScope(accountScope); assertAttemptKey(attemptKey)
    return transactTaskAttemptAccount<boolean>(accountScope, 'readwrite', rows => {
      const current = rows.find(row => row.attemptKey === attemptKey)
      if (!current) return { result: false }
      if (current.phase !== 'accepted' && current.phase !== 'abandoned') {
        throw new AgentComposerTaskAttemptStoreError('task_attempt_conflict', 'Only accepted or abandoned attempts can be removed.')
      }
      return { result: true, delete: [[accountScope, current.targetSlot]] }
    }, this.factory)
  }
}
