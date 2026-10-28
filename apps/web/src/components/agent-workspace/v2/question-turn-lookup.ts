import type { SupervisorTurnSummary } from './task-tree-projection'

const ACTIVE_TURN_STATUSES = new Set(['queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user'])
const MAX_TURN_REVISION = 2_147_483_647

/** Adds the URL-scoped current Turn only to action lookup, never the supervisor tree. */
export function includeCurrentQuestionTurn(
  turns: readonly SupervisorTurnSummary[],
  sessionId: string | null,
  projection: unknown,
): SupervisorTurnSummary[] {
  return includeCurrentActionTurn(turns, sessionId, projection, 'waiting_for_user')
}

export function includeCurrentApprovalTurn(
  turns: readonly SupervisorTurnSummary[],
  sessionId: string | null,
  projection: unknown,
): SupervisorTurnSummary[] {
  // Approval eligibility belongs to the ledger and Broker, not the Turn's display status.
  return includeCurrentActionTurn(turns, sessionId, projection, null)
}

function includeCurrentActionTurn(
  turns: readonly SupervisorTurnSummary[],
  sessionId: string | null,
  projection: unknown,
  waitingStatus: 'waiting_for_user' | null,
): SupervisorTurnSummary[] {
  if (!safeId(sessionId)) return []
  // An invalid projection is ignored; existing eligible page records remain the fallback.
  const answerableTurns = turns.filter(turn => turn.sessionId === sessionId && (waitingStatus === null || turn.status === waitingStatus))
  if (!isRecord(projection) || !safeId(projection.activeTurnId) || !isRecord(projection.activeTurn)) return answerableTurns

  const active = projection.activeTurn
  if (active.id !== projection.activeTurnId || !safeId(active.id) || (active.sessionId !== undefined && active.sessionId !== sessionId) ||
    typeof active.status !== 'string' || !ACTIVE_TURN_STATUSES.has(active.status)) return answerableTurns
  if (waitingStatus !== null && active.status !== waitingStatus) return answerableTurns.filter(turn => turn.id !== active.id)
  if (!safeRevision(active.revision)) return answerableTurns

  const current = answerableTurns.find(turn => turn.id === active.id)
  const refreshed: SupervisorTurnSummary = current
    ? { ...current, status: active.status, revision: active.revision }
    // Action cards consume only identity, status and revision from this synthetic summary.
    : { id: active.id, sessionId, source: 'active_projection', goal: '', status: active.status, revision: active.revision,
        activeStepId: null, finalItemId: null, createdAt: '', updatedAt: '', completedAt: null }
  const withoutDuplicates = answerableTurns.filter(turn => turn.id !== active.id)
  return [...withoutDuplicates, refreshed]
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
}

function safeRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TURN_REVISION
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
