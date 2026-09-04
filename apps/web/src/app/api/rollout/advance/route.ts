import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { getRolloutStage, decideAdvance, parseEnvironment, rollbackTarget, stageTransitionData } from '@/lib/rollout/stage-controller'
import type { RolloutMetrics } from '@/lib/rollout/flags'

export const runtime = 'nodejs'

type AdvanceBody = {
  environment?: unknown
  stage?: unknown
  stageKey?: unknown
  targetStage?: unknown
  expectedVersion?: unknown
  reason?: unknown
  metrics?: unknown
}

export async function POST(request: NextRequest) {
  const actor = await requireAdmin('feature_flags.update', request)
  if (isAdminResponse(actor)) return actor
  const body = await request.json().catch(() => null) as AdvanceBody | null
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
  const requestedStage = typeof body?.stageKey === 'string' ? body.stageKey : typeof body?.targetStage === 'string' ? body.targetStage : body?.stage
  const metrics = parseMetrics(body?.metrics)
  if (metrics === null || metrics === undefined) return NextResponse.json({ error: 'Complete numeric metrics are required before advancing a stage' }, { status: 400 })
  const decision = decideAdvance(current, requestedStage, metrics)
  if (!decision.ok) {
    if (decision.code === 'ROLLBACK_REQUIRED') return automaticRollback(actor, current, decision.reasons ?? [], idempotencyKey, reason)
    const status = decision.code === 'OBSERVATION_WINDOW_OPEN' ? 409 : 400
    return NextResponse.json({ error: decision.code, stage: current.stageKey }, { status })
  }
  const expectedVersion = readVersion(body?.expectedVersion, current.version)
  if (expectedVersion === null) return NextResponse.json({ error: 'expectedVersion must be a positive integer' }, { status: 400 })
  const now = new Date()
  const transition = stageTransitionData(decision.targetStage, actor.userId, now)
  const result = await runAdminMutation({
    actorUserId: actor.userId,
    action: 'rollout.stage_advanced',
    idempotencyKey,
    targetId: environment,
    audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'feature_flag', targetId: environment, reason, outcome: 'success', after: { from: current.stageKey, to: decision.targetStage, version: expectedVersion + 1 } },
    mutate: (tx) => tx.rolloutStage.updateMany({ where: { environment, version: expectedVersion, status: { in: ['active', 'rolled_back'] } }, data: transition }),
  })
  if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  if (!(result.value as { count: number }).count) return NextResponse.json({ error: 'Rollout stage changed; reload status and retry' }, { status: 409 })
  return NextResponse.json({ environment, previousStage: current.stageKey, stage: decision.targetStage, version: expectedVersion + 1, observationEndsAt: decision.observation.end.toISOString() }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}

async function automaticRollback(actor: { userId: string; roleKey: string; requestId: string }, current: Awaited<ReturnType<typeof getRolloutStage>>['stage'], reasons: readonly string[], idempotencyKey: string, reason: string) {
  const target = rollbackTarget(current)
  if (!target) return NextResponse.json({ error: 'ROLLBACK_REQUIRED', reasons, stage: current.stageKey, blocked: true }, { status: 409 })
  const now = new Date()
  const transition = stageTransitionData(target, actor.userId, now, `automatic: ${reasons.join(',')}`)
  const result = await runAdminMutation({
    actorUserId: actor.userId,
    action: 'rollout.auto_rollback',
    idempotencyKey,
    targetId: current.environment,
    audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'feature_flag', targetId: current.environment, reason, outcome: 'success', after: { from: current.stageKey, to: target, reasons } },
    mutate: (tx) => tx.rolloutStage.updateMany({ where: { environment: current.environment, version: current.version, status: { in: ['active', 'rolled_back'] } }, data: transition }),
  })
  if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  if (!(result.value as { count: number }).count) return NextResponse.json({ error: 'Rollout stage changed; reload status and retry' }, { status: 409 })
  return NextResponse.json({ environment: current.environment, automaticRollback: true, previousStage: current.stageKey, stage: target, version: current.version + 1, reasons }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
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
