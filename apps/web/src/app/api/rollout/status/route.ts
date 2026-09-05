import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { getRolloutStage, parseEnvironment } from '@/lib/rollout/stage-controller'
import {
  ROLLBACK_THRESHOLDS,
  ROLLOUT_STAGES,
  isObservationComplete,
  observationWindow,
} from '@/lib/rollout/flags'
import { summarizeRolloutDiffs } from '@/lib/rollout/diff-store'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('feature_flags.read', request)
  if (isAdminResponse(actor)) return actor
  let environment: ReturnType<typeof parseEnvironment>
  try {
    environment = parseEnvironment(new URL(request.url).searchParams.get('environment'))
  } catch {
    return NextResponse.json({ error: 'Unsupported rollout environment' }, { status: 400 })
  }
  const { stage, persisted } = await getRolloutStage(environment)
  let diffSummary: Awaited<ReturnType<typeof summarizeRolloutDiffs>> | null = null
  let diffStorageAvailable = true
  try {
    diffSummary = await summarizeRolloutDiffs(environment)
  } catch {
    // The route remains useful during a rolling deploy, while the response
    // truthfully signals that the additive diff migration is not ready.
    diffStorageAvailable = false
  }
  const observation = stage.observationStartedAt ? observationWindow(stage.stageKey, stage.observationStartedAt) : null
  return NextResponse.json({
    environment,
    persisted,
    current: {
      stage: stage.stageKey,
      rolloutPercent: stage.rolloutPercent,
      enabled: stage.enabled,
      status: stage.status,
      version: stage.version,
      internalUserCount: stage.internalUserIds.length,
      observationStartedAt: stage.observationStartedAt instanceof Date ? stage.observationStartedAt.toISOString() : stage.observationStartedAt,
      observationEndsAt: stage.observationEndsAt instanceof Date ? stage.observationEndsAt.toISOString() : stage.observationEndsAt,
      observationComplete: isObservationComplete(stage.stageKey, stage.observationStartedAt),
      lastTransitionAt: stage.lastTransitionAt instanceof Date ? stage.lastTransitionAt.toISOString() : stage.lastTransitionAt,
    },
    observation: observation ? { start: observation.start.toISOString(), end: observation.end.toISOString() } : null,
    stages: ROLLOUT_STAGES,
    thresholds: ROLLBACK_THRESHOLDS,
    allocation: { decisionPoint: 'session.start', algorithm: 'sha256(sessionId) mod 10000', internalOnlyUsesAllowList: true },
    diffStorageAvailable,
    diffSummary,
    actor: { roleKey: actor.roleKey },
  }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
