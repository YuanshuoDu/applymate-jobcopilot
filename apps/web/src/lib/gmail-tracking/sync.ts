import { db } from '@/lib/db'
import { getGoogleAccessToken } from '@/lib/gmail-helpers'
import { classifyGmailMessage, extractRecommendationCards, inferApplicationMetadata } from './index'
import type { GmailMessageKind } from './classification'
import { fetchRecentGmailMessages, type GmailRemoteMessage } from './gmail-client'
import { activityTypeForGmailMessage, canApplyGmailStatus, gmailEventLabel, statusForGmailMessage } from './lifecycle'
import { findConfidentGmailJobMatch, type GmailMatchableJob } from './matching'
import { extractInterviewSchedule } from './interview-schedule'
import { readNotificationPreferences } from '@/lib/settings-preferences'
import type { NotificationPreferences } from '@/lib/types'
import { purgeTemporaryGeneratedCoverLetters } from '@/lib/cover-letter-retention'

export interface GmailSyncResult {
  connected: boolean
  importedMessages: number
  matchedMessages: number
  statusUpdates: number
  newRecommendations: number
  error: string | null
}

const EMPTY_RESULT: GmailSyncResult = {
  connected: false,
  importedMessages: 0,
  matchedMessages: 0,
  statusUpdates: 0,
  newRecommendations: 0,
  error: null,
}

export async function syncGmailForUser(userId: string, now = new Date()): Promise<GmailSyncResult> {
  const accessToken = await getGoogleAccessToken(userId).catch(() => null)
  if (!accessToken) return EMPTY_RESULT

  const user = await db.user.findUnique({ where: { id: userId }, select: { preferences: true } }).catch(() => null)
  const notificationPreferences = readNotificationPreferences(user?.preferences)

  const syncState = await db.gmailSyncState.upsert({
    where: { userId },
    create: { userId },
    update: {},
  })
  await backfillInterviewSchedules(userId)
  const since = syncState.lastSyncedAt
    ? new Date(syncState.lastSyncedAt.getTime() - 86_400_000)
    : null

  try {
    const [messages, jobs] = await Promise.all([
      fetchRecentGmailMessages(accessToken, since),
      db.job.findMany({
        where: { userId },
        select: { id: true, company: true, role: true, status: true, appliedAt: true },
      }),
    ])
    const orderedMessages = messages.sort((left, right) => left.receivedAt.getTime() - right.receivedAt.getTime())
    const result: GmailSyncResult = { ...EMPTY_RESULT, connected: true }

    for (const message of orderedMessages) {
      const processed = await processMessage(userId, message, jobs, now, notificationPreferences)
      result.importedMessages += processed.imported ? 1 : 0
      result.matchedMessages += processed.matched ? 1 : 0
      result.statusUpdates += processed.statusUpdated ? 1 : 0
      result.newRecommendations += processed.recommendations
    }

    await db.gmailSyncState.update({
      where: { userId },
      data: { lastSyncedAt: now, lastError: null },
    })
    if (result.newRecommendations > 0) await notifyNewRecommendations(userId, result.newRecommendations, now)
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Gmail sync failed'
    await db.gmailSyncState.update({ where: { userId }, data: { lastError: message } }).catch(() => undefined)
    return { ...EMPTY_RESULT, connected: true, error: message }
  }
}

async function processMessage(
  userId: string,
  message: GmailRemoteMessage,
  jobs: Array<GmailMatchableJob & { appliedAt: Date | null }>,
  now: Date,
  notificationPreferences: NotificationPreferences,
) {
  const existing = await db.gmailMessage.findUnique({
    where: { userId_gmailMessageId: { userId, gmailMessageId: message.id } },
    select: { id: true, kind: true, scheduledAt: true },
  })
  if (existing) {
    if (existing.kind === 'interview_invitation' && !existing.scheduledAt) {
      const scheduledAt = extractInterviewSchedule(`${message.subject}\n${message.text}`, message.receivedAt)
      if (scheduledAt) await db.gmailMessage.update({ where: { id: existing.id }, data: { scheduledAt } })
    }
    return { imported: false, matched: false, statusUpdated: false, recommendations: 0 }
  }

  const kind = classifyGmailMessage({ subject: message.subject, excerpt: message.snippet, body: message.text })
  if (kind === 'other') return { imported: false, matched: false, statusUpdated: false, recommendations: 0 }

  const inferred = inferApplicationMetadata(message.subject)
  const match = findConfidentGmailJobMatch(jobs, {
    ...inferred,
    subject: message.subject,
    senderEmail: message.senderEmail,
  })
  const scheduledAt = kind === 'interview_invitation'
    ? extractInterviewSchedule(`${message.subject}\n${message.text}`, message.receivedAt)
    : null
  const tracked = await createTrackedMessage(userId, message, kind, inferred, match?.job.id ?? null, match?.confidence ?? null, scheduledAt, now)
  if (!tracked) return { imported: false, matched: false, statusUpdated: false, recommendations: 0 }

  const recommendations = kind === 'recommendation_digest'
    ? await persistRecommendations(userId, tracked.id, message)
    : 0
  if (!match) return { imported: true, matched: false, statusUpdated: false, recommendations }

  const statusUpdated = await projectLinkedMessage(userId, match.job, message, kind, notificationPreferences)
  return { imported: true, matched: true, statusUpdated, recommendations }
}

async function createTrackedMessage(
  userId: string,
  message: GmailRemoteMessage,
  kind: GmailMessageKind,
  inferred: { company: string | null; role: string | null },
  jobId: string | null,
  matchConfidence: number | null,
  scheduledAt: Date | null,
  now: Date,
) {
  try {
    return await db.gmailMessage.create({
      data: {
        userId,
        gmailMessageId: message.id,
        gmailThreadId: message.threadId,
        kind,
        senderEmail: message.senderEmail,
        senderName: message.senderName,
        subject: message.subject || '(No subject)',
        excerpt: truncate(message.text || message.snippet, 1_500),
        inferredCompany: inferred.company,
        inferredRole: inferred.role,
        receivedAt: message.receivedAt,
        scheduledAt,
        jobId,
        matchConfidence,
        processedAt: now,
      },
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) return null
    throw error
  }
}

async function persistRecommendations(userId: string, sourceMessageId: string, message: GmailRemoteMessage): Promise<number> {
  const cards = extractRecommendationCards({
    html: message.html,
    text: message.text || message.snippet,
    platform: platformFromSender(message.senderEmail),
  })
  let created = 0
  for (const card of cards) {
    try {
      await db.gmailRecommendation.create({
        data: { userId, sourceMessageId, ...card },
      })
      created += 1
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error
    }
  }
  return created
}

async function backfillInterviewSchedules(userId: string) {
  const messages = await db.gmailMessage.findMany({
    where: { userId, kind: 'interview_invitation', scheduledAt: null },
    select: { id: true, subject: true, excerpt: true, receivedAt: true },
    orderBy: { receivedAt: 'desc' },
    take: 100,
  })
  await Promise.all(messages.map(async message => {
    const scheduledAt = extractInterviewSchedule(`${message.subject}\n${message.excerpt ?? ''}`, message.receivedAt)
    if (scheduledAt) await db.gmailMessage.update({ where: { id: message.id }, data: { scheduledAt } })
  }))
}

async function projectLinkedMessage(
  userId: string,
  job: GmailMatchableJob & { appliedAt: Date | null },
  message: GmailRemoteMessage,
  kind: GmailMessageKind,
  notificationPreferences: NotificationPreferences,
): Promise<boolean> {
  const nextStatus = statusForGmailMessage(kind)
  const statusUpdated = Boolean(nextStatus && canApplyGmailStatus(job.status, nextStatus))
  if (nextStatus && statusUpdated) {
    await db.job.update({
      where: { id: job.id },
      data: {
        status: nextStatus,
        workflowState: 'submitted',
        ...(nextStatus === 'applied' && !job.appliedAt ? { appliedAt: message.receivedAt } : {}),
      },
    })
    job.status = nextStatus
    if (nextStatus === 'applied' && !job.appliedAt) job.appliedAt = message.receivedAt
    if (nextStatus === 'applied') await purgeTemporaryGeneratedCoverLetters(userId, job.id).catch(() => undefined)
  }

  await db.activity.create({
    data: {
      userId,
      jobId: job.id,
      type: activityTypeForGmailMessage(kind),
      text: `Gmail ${gmailEventLabel(kind)} from ${job.company} for ${job.role}${statusUpdated ? ` — status updated to ${nextStatus}` : ''}`,
      color: colorForGmailKind(kind),
    },
  })
  if (statusUpdated) await createStatusNotification(userId, job.id, job.company, job.role, kind, notificationPreferences)
  return statusUpdated
}

function gmailPreferenceKey(kind: GmailMessageKind): keyof NotificationPreferences {
  if (kind === 'rejection') return 'reject'
  if (kind === 'interview_invitation') return 'interview'
  if (kind === 'offer') return 'offer'
  return 'apply'
}

async function createStatusNotification(
  userId: string,
  jobId: string,
  company: string,
  role: string,
  kind: GmailMessageKind,
  notificationPreferences: NotificationPreferences,
) {
  if (!notificationPreferences[gmailPreferenceKey(kind)]) return
  await db.notification.create({
    data: {
      userId,
      jobId,
      type: 'gmail_application_update',
      title: `${company}: ${gmailEventLabel(kind)}`,
      body: role,
    },
  }).catch(() => undefined)
}

async function notifyNewRecommendations(userId: string, count: number, now: Date) {
  const dayStart = new Date(now)
  dayStart.setHours(0, 0, 0, 0)
  const existing = await db.notification.findFirst({
    where: { userId, type: 'gmail_recommendations', createdAt: { gte: dayStart } },
    select: { id: true },
  }).catch(() => null)
  if (existing) return
  await db.notification.create({
    data: {
      userId,
      type: 'gmail_recommendations',
      title: `${count} new recommended job${count === 1 ? '' : 's'} from Gmail`,
      body: 'Review and save the roles that fit your search.',
    },
  }).catch(() => undefined)
}

function colorForGmailKind(kind: GmailMessageKind): string {
  if (kind === 'rejection') return '#DC2626'
  if (kind === 'offer') return '#0284C7'
  if (kind === 'interview_invitation') return '#059669'
  return '#4F46E5'
}

function platformFromSender(email: string | null): string | null {
  if (!email?.includes('@')) return null
  return email.slice(email.lastIndexOf('@') + 1).replace(/^mail\./, '')
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}
