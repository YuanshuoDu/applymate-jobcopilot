/**
 * GET /api/dashboard — aggregated stats for the dashboard page
 */
import { requireAuth, isErrorResponse, ok } from '@/lib/api-helpers'
import { db } from '@/lib/db'

export async function GET() {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const userId = auth.userId

  // Pipeline counts grouped by status
  const statusGroups = await db.job.groupBy({
    by: ['status'],
    where: { userId },
    _count: { status: true },
  })

  const pipeline: Record<string, number> = {}
  for (const g of statusGroups) {
    pipeline[g.status] = g._count.status
  }

  const total      = Object.values(pipeline).reduce((a, b) => a + b, 0)
  const applied    = (pipeline.applied    ?? 0) + (pipeline.review ?? 0) + (pipeline.interview ?? 0) + (pipeline.offer ?? 0) + (pipeline.rejected ?? 0)
  const inReview   = pipeline.review    ?? 0
  const interviews = pipeline.interview ?? 0
  const offers     = pipeline.offer     ?? 0

  // Jobs applied this week
  const weekStart = new Date()
  weekStart.setDate(weekStart.getDate() - 7)
  const thisWeek = await db.job.count({
    where: { userId, appliedAt: { gte: weekStart } },
  })

  // Recent jobs (last 5 applied/in-progress)
  const recentJobs = await db.job.findMany({
    where: {
      userId,
      status: { in: ['applied', 'review', 'interview', 'offer', 'rejected'] },
    },
    orderBy: { updatedAt: 'desc' },
    take: 5,
  })

  // Recent activity
  const activity = await db.activity.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 8,
  })

  // Agent config
  const agentConfig = await db.agentConfig.findUnique({ where: { userId } })

  return ok({
    stats: { total, applied, inReview, interviews, offers, thisWeek },
    pipeline,
    recentJobs,
    activity,
    agentConfig,
  })
}
