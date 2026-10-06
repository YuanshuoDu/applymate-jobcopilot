import type { SupervisorTurnSummary } from './task-tree-projection'

const ACTIVE_TURN_STATUSES = new Set(['queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user'])
const MAX_TURN_REVISION = 2_147_483_647

/** Adds the URL-scoped current Turn only to question lookup, never the supervisor tree. */
export function includeCurrentQuestionTurn(
  turns: readonly SupervisorTurnSummary[],
  sessionId: string | null,
  projection: unknown,
): SupervisorTurnSummary[] {
  if (!safeId(sessionId)) return []
  const answerableTurns = turns.filter(turn => turn.sessionId === sessionId && turn.status === 'waiting_for_user')
  if (!isRecord(projection) || !safeId(projection.activeTurnId) || !isRecord(projection.activeTurn)) return answerableTurns
  const active = projection.activeTurn
  if (active.id !== projection.activeTurnId || !safeId(active.id) || (active.sessionId !== undefined && active.sessionId !== sessionId) ||
    typeof active.status !== 'string' || !ACTIVE_TURN_STATUSES.has(active.status)) return answerableTurns
  if (active.status !== 'waiting_for_user') return answerableTurns.filter(turn => turn.id !== active.id)
  if (!safeRevision(active.revision)) return answerableTurns

  const current = answerableTurns.find(turn => turn.id === active.id)
  const refreshed: SupervisorTurnSummary = current
    ? { ...current, status: active.status, revision: active.revision }
    // This summary is consumed only by AgentQuestionInputCard, which reads identity and revision.
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
