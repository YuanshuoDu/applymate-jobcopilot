/**
 * POST /api/jobs/[id]/apply
 * User confirms they manually applied to a job.
 * Updates status to 'applied' and sets appliedAt.
 */
import { NextRequest }                          from 'next/server'
import { db }                                    from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { purgeTemporaryGeneratedCoverLetters } from '@/lib/cover-letter-retention'
import { checkEntitlementLimit } from '@/lib/entitlements'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { id } = await params
  const job = await db.job.findFirst({ where: { id, userId: auth.userId } })
  if (!job) return err('Job not found', 404)

  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)
  const usage = await db.job.count({ where: { userId: auth.userId, status: 'applied', appliedAt: { gte: monthStart } } })
  const quota = await checkEntitlementLimit(auth.userId, 'applications', usage)
  if (!quota.allowed) {
    const limitReached = quota.reason === 'limit_reached'
    const message = limitReached ? 'Your monthly application limit has been reached.' : 'Your current plan does not include manual applications.'
    const requestId = req.headers.get('X-Manual-Record-Request-Id')
    const validRequestId = requestId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)
    if (validRequestId && (limitReached || quota.reason === 'missing' || quota.reason === 'expired')) {
      return ok({ error: message, code: limitReached ? 'MANUAL_APPLICATION_LIMIT_REACHED' : 'MANUAL_APPLICATION_PLAN_RESTRICTED', requestId }, 403)
    }
    return err(message, 403)
  }

  const recorded = await db.$transaction(async tx => {
    // This conditional write is the decision point for competing manual records.
    const result = await tx.job.updateMany({
      where: { id, userId: auth.userId, status: 'saved', workflowState: { in: ['draft', 'ready_to_apply'] }, appliedAt: null },
      data: { status: 'applied', workflowState: 'submitted', appliedAt: new Date() },
    })
    if (result.count !== 1) return false
    await tx.activity.create({
      data: {
        userId: auth.userId,
        jobId: id,
        type: 'applied',
        text: `You applied manually ${job.company} · ${job.role}`,
        color: '#059669',
      },
    })
    return true
  })
  if (!recorded) return err('Application state changed. Refresh the application before recording.', 409)
  await purgeTemporaryGeneratedCoverLetters(auth.userId, id).catch(() => undefined)

  return ok({ applied: true })
}
