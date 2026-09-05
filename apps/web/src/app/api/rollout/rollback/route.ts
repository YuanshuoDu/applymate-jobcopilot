import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { getRolloutStage, parseEnvironment, rollbackTarget, stageTransitionData } from '@/lib/rollout/stage-controller'
import { evaluateRollbackThresholds, type RolloutMetrics } from '@/lib/rollout/flags'

export const runtime = 'nodejs'

type RollbackBody = {
  environment?: unknown
  expectedVersion?: unknown
  reason?: unknown
  automatic?: unknown
  metrics?: unknown
}

export async function POST(request: NextRequest) {
  const actor = await requireAdmin('feature_flags.approve', request)
  if (isAdminResponse(actor)) return actor
  const body = await request.json().catch(() => null) as RollbackBody | null
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? ''
  if (reason.length < 10 || reason.length > 500 || idempotencyKey.length < 8 || idempotencyKey.length > 200) return NextResponse.json({ error: 'reason and Idempotency-Key are required' }, { status: 400 })
  let environment: ReturnType<typeof parseEnvironment>
  try {
    environment = parseEnvironment(typeof body?.environment === 'string' ? body.environment : new URL(request.url).searchParams.get('environment'))
  } catch {
    return NextResponse.json({ error: 'Unsupported rollout environment' }, { status: 400 })
  }
  const { stage: current } = await getRolloutStage(environment)
  const target = rollbackTarget(current)
  if (!target) return NextResponse.json({ error: 'ALREADY_AT_INTERNAL_ONLY', stage: current.stageKey }, { status: 409 })
  const automatic = body?.automatic === true
  const metrics = parseMetrics(body?.metrics)
  if (automatic && metrics === null) return NextResponse.json({ error: 'metrics must contain numeric rollout values' }, { status: 400 })
  const evaluation = automatic ? evaluateRollbackThresholds(metrics ?? {}) : null
  if (automatic && !evaluation?.shouldRollback) return NextResponse.json({ error: 'ROLLBACK_NOT_REQUIRED', metrics: evaluation?.metrics }, { status: 409 })
  const expectedVersion = readVersion(body?.expectedVersion, current.version)
  if (expectedVersion === null) return NextResponse.json({ error: 'expectedVersion must be a positive integer' }, { status: 400 })
  const now = new Date()
  const rollbackReason = evaluation?.reasons.length ? `automatic: ${evaluation.reasons.join(',')}` : reason
  const transition = stageTransitionData(target, actor.userId, now, rollbackReason)
  const result = await runAdminMutation({
    actorUserId: actor.userId,
    action: automatic ? 'rollout.auto_rollback' : 'rollout.stage_rollback',
    idempotencyKey,
    targetId: environment,
    audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'feature_flag', targetId: environment, reason, outcome: 'success', after: { from: current.stageKey, to: target, automatic, reasons: evaluation?.reasons ?? [] } },
    mutate: (tx) => tx.rolloutStage.updateMany({ where: { environment, version: expectedVersion, status: { in: ['active', 'blocked', 'rolled_back'] } }, data: transition }),
  })
  if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  if (!(result.value as { count: number }).count) return NextResponse.json({ error: 'Rollout stage changed; reload status and retry' }, { status: 409 })
  return NextResponse.json({ environment, automaticRollback: automatic, previousStage: current.stageKey, stage: target, version: expectedVersion + 1, reasons: evaluation?.reasons ?? [] }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}

function readVersion(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function parseMetrics(value: unknown): Partial<RolloutMetrics> | null | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const allowed = new Set<keyof RolloutMetrics>(['turnCompletionRate', 'unauthorizedExternalAction', 'submissionDuplicate', 'replayConsistency', 'costP95Ratio'])
  const result: Partial<RolloutMetrics> = {}
  for (const [key, metric] of Object.entries(value)) {
    if (!allowed.has(key as keyof RolloutMetrics) || typeof metric !== 'number' || !Number.isFinite(metric)) return null
    result[key as keyof RolloutMetrics] = metric
  }
  return result
}
