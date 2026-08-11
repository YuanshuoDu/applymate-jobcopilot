import { NextRequest } from 'next/server'
import { pinnedFetch } from '@jobcopilot/shared'
import { db } from '@/lib/db'
import { err, ok } from '@/lib/api-helpers'
import { configuredAppOrigin } from '@/lib/app-url'
import { readNotificationPreferences } from '@/lib/settings-preferences'
import {
  dailyNotificationId,
  formatWeeklySummary,
  isWeeklySummaryDay,
  utcWeekKey,
  weekStartUtc,
  type WeeklySummaryCounts,
} from '@/lib/notifications/daily'

type UserRow = { id: string; email: string; name: string | null; preferences: unknown }
type JobRow = {
  id: string
  userId: string
  company: string
  role: string
  status: string
  followUpAt: Date | null
  appliedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

function authorized(req: NextRequest): boolean {
  const secret = process.env.NOTIFICATIONS_CRON_SECRET ?? process.env.CRON_SECRET
  if (!secret) return process.env.NODE_ENV !== 'production'
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  return bearer === secret || req.headers.get('x-notifications-cron-secret') === secret
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character))
}

async function createOnce(data: { id: string; userId: string; type: string; title: string; body: string; jobId?: string }): Promise<boolean> {
  try {
    await db.notification.create({ data })
    return true
  } catch (error) {
    // The deterministic id is the idempotency key. A second cron invocation
    // must be harmless even when two invocations race.
    if (isUniqueViolation(error)) return false
    throw error
  }
}

async function sendEmail(user: UserRow, subject: string, lines: string[]): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey || !user.email) return false
  const baseUrl = configuredAppOrigin('https://applymate.site')
  const htmlLines = lines.map(line => `<li>${escapeHtml(line)}</li>`).join('')
  const response = await pinnedFetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.RESEND_FROM ?? 'ApplyMate <noreply@applymate.dev>',
      to: user.email,
      subject,
      html: `<p>Hi ${escapeHtml(user.name?.trim() || 'there')},</p><ul>${htmlLines}</ul><p><a href="${baseUrl}/?page=dashboard">Open ApplyMate</a></p>`,
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)
  return Boolean(response?.ok)
}

function emptyCounts(): WeeklySummaryCounts {
  return { applied: 0, interviews: 0, offers: 0, rejections: 0, newJobs: 0 }
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return err('Unauthorized', 401)

  const now = new Date()
  const start = weekStartUtc(now)
  const users = await db.user.findMany({
    where: { accountStatus: 'active' },
    select: { id: true, email: true, name: true, preferences: true },
    take: 10_000,
  }) as UserRow[]
  if (users.length === 0) return ok({ checked: 0, notifications: 0, emails: 0, weekly: false })

  const jobs = await db.job.findMany({
    where: {
      userId: { in: users.map(user => user.id) },
      OR: [
        { followUpAt: { not: null, lte: now }, status: { notIn: ['offer', 'rejected'] } },
        { updatedAt: { gte: start } },
        { createdAt: { gte: start } },
      ],
    },
    select: { id: true, userId: true, company: true, role: true, status: true, followUpAt: true, appliedAt: true, createdAt: true, updatedAt: true },
    take: 20_000,
  }) as JobRow[]

  const jobsByUser = new Map<string, JobRow[]>()
  const countsByUser = new Map<string, WeeklySummaryCounts>()
  for (const job of jobs) {
    const userJobs = jobsByUser.get(job.userId) ?? []
    userJobs.push(job)
    jobsByUser.set(job.userId, userJobs)
    const counts = countsByUser.get(job.userId) ?? emptyCounts()
    if (job.createdAt >= start) counts.newJobs += 1
    if (job.appliedAt && job.appliedAt >= start) counts.applied += 1
    if (job.updatedAt >= start) {
      if (job.status === 'interview') counts.interviews += 1
      if (job.status === 'offer') counts.offers += 1
      if (job.status === 'rejected') counts.rejections += 1
    }
    countsByUser.set(job.userId, counts)
  }

  let notifications = 0
  let emails = 0
  const weekly = isWeeklySummaryDay(now)
  for (const user of users) {
    const preferences = readNotificationPreferences(user.preferences)
    const emailLines: string[] = []
    const userJobs = jobsByUser.get(user.id) ?? []

    if (preferences.followUp) {
      for (const job of userJobs) {
        if (!job.followUpAt || job.followUpAt > now || job.status === 'offer' || job.status === 'rejected') continue
        const created = await createOnce({
          id: dailyNotificationId('follow-up', user.id, `${job.id}:${job.followUpAt.toISOString()}`),
          userId: user.id,
          jobId: job.id,
          type: 'follow_up_due',
          title: `Follow up with ${job.company}`,
          body: `${job.role} is ready for a follow-up.`,
        })
        if (created) {
          notifications += 1
          emailLines.push(`Follow up with ${job.company} about ${job.role}`)
        }
      }
    }

    if (weekly && preferences.weekly) {
      const summary = formatWeeklySummary(countsByUser.get(user.id) ?? emptyCounts())
      const created = await createOnce({
        id: dailyNotificationId('weekly', user.id, utcWeekKey(now)),
        userId: user.id,
        type: 'weekly_summary',
        title: summary.title,
        body: summary.body,
      })
      if (created) {
        notifications += 1
        emailLines.push(summary.body)
      }
    }

    if (emailLines.length > 0 && await sendEmail(user, 'Your ApplyMate updates', emailLines)) emails += 1
  }

  return ok({ checked: users.length, notifications, emails, weekly })
}

export async function GET(req: NextRequest) {
  return POST(req)
}
