/**
 * GET /api/dashboard — aggregated stats for the dashboard page
 */
import { requireAuth, isErrorResponse, ok } from '@/lib/api-helpers'
import { db } from '@/lib/db'

function getDateParam(value: string | null, fallback: Date, endOfDay = false) {
  if (!value) return fallback
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return fallback
  if (endOfDay) date.setHours(23, 59, 59, 999)
  else date.setHours(0, 0, 0, 0)
  return date
}

export async function GET(request: Request) {
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

  // Jobs applied inside the selected dashboard week. Defaults to the last 7 days
  // to preserve the original dashboard behaviour for existing callers.
  const params = new URL(request.url).searchParams
  const defaultStart = new Date()
  defaultStart.setDate(defaultStart.getDate() - 7)
  const defaultEnd = new Date()
  const rangeStart = getDateParam(params.get('from'), defaultStart)
  const rangeEnd = getDateParam(params.get('to'), defaultEnd, true)
  const thisWeek = await db.job.count({
    where: { userId, appliedAt: { gte: rangeStart, lte: rangeEnd } },
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

  // Agent settings control which saved roles are genuinely high-match.
  const agentConfig = await db.agentConfig.findUnique({ where: { userId } })
  const minMatchScore = agentConfig?.minMatchScore ?? 75

  // Saved roles that meet the user's configured match threshold.
  const savedJobs = await db.job.findMany({
    where: { userId, status: 'saved', score: { gte: minMatchScore } },
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
    minMatchScore,
    hasResume: resumeCount > 0,
  })
}
