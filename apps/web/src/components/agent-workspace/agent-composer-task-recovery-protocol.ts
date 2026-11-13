import { AgentComposerTaskAttemptStoreError, type AgentComposerTaskAttemptPhase } from './agent-composer-task-attempt-store'

export type AgentComposerTaskRecoveryNoticeState =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'accepted'; sessionId: string; turnId: string }>
  | Readonly<{ kind: 'unknown'; busy?: boolean }>
  | Readonly<{ kind: 'abandoned'; sessionId?: string }>
  | Readonly<{ kind: 'unavailable'; reason: 'storage' | 'error' | 'accepted-target-missing' }>

export type AgentComposerTaskRecoveryItem = Readonly<{
  attemptKey: string
  state: AgentComposerTaskRecoveryNoticeState
}>

export type AgentComposerTaskRecoverySnapshot =
  | Readonly<{ kind: 'ready'; accountScope: string; attempts: readonly AgentComposerTaskRecoveryItem[] }>
  | Readonly<{ kind: 'unavailable'; reason: 'storage' | 'error' }>

export type AgentComposerTaskRecoveryReason = 'storage' | 'error' | 'accepted-target-missing'
export type AgentComposerTaskRecoveryReceipt = Readonly<{ sessionId: string; turnId: string; inputId: string; sequence: string }>
export type AgentComposerTaskRecoveryServerAttempt =
  | Readonly<{ state: 'accepted'; receipt: AgentComposerTaskRecoveryReceipt }>
  | Readonly<{ state: 'unknown' } | { state: 'abandoned' } | { state: 'unavailable' }>
export type AgentComposerTaskRecoveryCreateResult =
  | Readonly<{ state: 'found'; sessionId: string }>
  | Readonly<{ state: 'unknown' }>
export type AgentComposerTaskRecoveryScopedBody = Record<string, unknown> & { accountScope: string }

export class AgentComposerTaskRecoveryError extends Error {
  constructor(readonly reason: AgentComposerTaskRecoveryReason) { super(reason) }
}

export function recoveryErrorState(reason: AgentComposerTaskRecoveryReason = 'error') {
  return { kind: 'unavailable', reason } as const
}

export function classifyRecoveryError(error: unknown): AgentComposerTaskRecoveryReason {
  if (error instanceof AgentComposerTaskRecoveryError) return error.reason
  if (error instanceof AgentComposerTaskAttemptStoreError) return 'storage'
  return 'error'
}

export function recoveryRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function validRecoveryId(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && /^[!-~]+$/.test(value)
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join('|') === [...expected].sort().join('|')
}

export function parseRecoveryAccountIndex(value: unknown, response: Response): string {
  if (!recoveryRecord(value) || !exactKeys(value, ['accountScope', 'attempts']) || !validRecoveryId(value.accountScope)
    || !Array.isArray(value.attempts) || value.attempts.length > 20
    || response.headers.get('X-Account-Scope') !== value.accountScope) throw new AgentComposerTaskRecoveryError('error')
  return value.accountScope
}

export function parseRecoveryScopedBody(value: unknown, response: Response, expectedScope: string): AgentComposerTaskRecoveryScopedBody {
  const headerScope = response.headers.get('X-Account-Scope')
  if (!recoveryRecord(value) || headerScope !== expectedScope
    || (value.accountScope !== undefined && value.accountScope !== expectedScope)) {
    throw new AgentComposerTaskRecoveryError('error')
  }
  return { ...value, accountScope: expectedScope }
}

export function parseRecoveryReceipt(value: unknown): AgentComposerTaskRecoveryReceipt | null {
  if (!recoveryRecord(value) || !exactKeys(value, ['sessionId', 'inputId', 'turnId', 'sequence'])) return null
  if (!validRecoveryId(value.sessionId) || !validRecoveryId(value.inputId) || !validRecoveryId(value.turnId)
    || typeof value.sequence !== 'string' || !/^[0-9]{1,20}$/.test(value.sequence)) return null
  return { sessionId: value.sessionId, inputId: value.inputId, turnId: value.turnId, sequence: value.sequence }
}

export function parseRecoveryAttempt(value: AgentComposerTaskRecoveryScopedBody): AgentComposerTaskRecoveryServerAttempt {
  if (value.state === 'unknown' && exactKeys(value, ['accountScope', 'state'])) return { state: 'unknown' }
  if (value.state === 'abandoned' && exactKeys(value, ['accountScope', 'state'])) return { state: 'abandoned' }
  if (value.state === 'unavailable' && exactKeys(value, ['accountScope', 'state'])) return { state: 'unavailable' }
  if (value.state === 'accepted' && exactKeys(value, ['accountScope', 'state', 'receipt'])) {
    const receipt = parseRecoveryReceipt(value.receipt)
    if (receipt) return { state: 'accepted', receipt }
  }
  throw new AgentComposerTaskRecoveryError('error')
}

export function parseRecoveryCreate(value: AgentComposerTaskRecoveryScopedBody): AgentComposerTaskRecoveryCreateResult {
  if (value.state === 'unknown' && exactKeys(value, ['accountScope', 'state'])) return { state: 'unknown' }
  if (value.state === 'found' && exactKeys(value, ['accountScope', 'state', 'sessionId']) && validRecoveryId(value.sessionId)) {
    return { state: 'found', sessionId: value.sessionId }
  }
  throw new AgentComposerTaskRecoveryError('error')
}

export function canAdvanceRecoveryPhase(current: AgentComposerTaskAttemptPhase, next: AgentComposerTaskAttemptPhase): boolean {
  return current === next || next === 'accepted' && current !== 'abandoned'
    || next === 'abandoned' && current !== 'accepted' && current !== 'abandoned'
    || next === 'unknown' && ['create-requested', 'session-known', 'start-requested'].includes(current)
}
