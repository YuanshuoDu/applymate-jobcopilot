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
  const saved      = pipeline.saved      ?? 0
  const applied    = pipeline.applied    ?? 0
  const inProgress = (pipeline.review ?? 0) + (pipeline.interview ?? 0)
  const interviews = pipeline.interview  ?? 0
  const offers     = pipeline.offer      ?? 0
  const rejected   = pipeline.rejected   ?? 0

  // Jobs applied this week
  const weekStart = new Date()
  weekStart.setDate(weekStart.getDate() - 7)
  const thisWeek = await db.job.count({
    where: { userId, appliedAt: { gte: weekStart } },
  })

  // Follow-ups due today or overdue (followUpAt <= end of today)
  const todayEnd = new Date()
  todayEnd.setHours(23, 59, 59, 999)
  const followUpsDue = await db.job.findMany({
    where: { userId, followUpAt: { lte: todayEnd } },
    select: { id: true, company: true, role: true, status: true, followUpAt: true },
    orderBy: { followUpAt: 'asc' },
    take: 10,
  })

  // Saved jobs awaiting decision (saved for 7+ days)
  const staleCutoff = new Date()
  staleCutoff.setDate(staleCutoff.getDate() - 7)
  const savedJobs = await db.job.findMany({
    where: { userId, status: 'saved' },
    select: { id: true, company: true, role: true, score: true, createdAt: true, url: true },
    orderBy: { score: { sort: 'desc', nulls: 'last' } },
    take: 8,
  })

  // Recent jobs (last 5 non-saved changes)
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

  // First-resume check (for onboarding)
  const resumeCount = await db.resume.count({ where: { userId } })

  return ok({
    stats: { total, saved, applied, inProgress, interviews, offers, rejected, thisWeek },
    pipeline,
    followUpsDue,
    savedJobs,
    recentJobs,
    activity,
    agentConfig,
    hasResume: resumeCount > 0,
  })
}
