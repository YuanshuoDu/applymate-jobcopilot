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
  if (!quota.allowed) return err(quota.reason === 'limit_reached' ? 'Your monthly application limit has been reached.' : 'Your current plan does not include manual applications.', 403)

  await db.job.update({
    where: { id },
    data:  { status: 'applied', workflowState: 'submitted', appliedAt: new Date() },
  })

  await db.activity.create({
    data: {
      userId: auth.userId,
      jobId:  id,
      type:   'applied',
      text:   `你手动申请了 ${job.company} · ${job.role}`,
      color:  '#059669',
    },
  })
  await purgeTemporaryGeneratedCoverLetters(auth.userId, id).catch(() => undefined)

  return ok({ applied: true })
}
