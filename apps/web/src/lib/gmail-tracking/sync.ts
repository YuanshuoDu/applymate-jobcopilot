import { db } from '@/lib/db'
import { getGoogleAccessToken } from '@/lib/gmail-helpers'
import { classifyGmailMessage, extractRecommendationCards, inferApplicationMetadata } from './index'
import type { GmailMessageKind } from './classification'
import { fetchRecentGmailMessages, type GmailRemoteMessage } from './gmail-client'
import { findConfidentGmailJobMatch, type GmailMatchableJob } from './matching'
import { recordLinkedGmailEvent, trackAndProjectLinkedStatusMessage, type GmailTrackedMessageData } from './gmail-status-projection'
import { extractInterviewSchedule } from './interview-schedule'
import { readNotificationPreferences } from '@/lib/settings-preferences'
import type { NotificationPreferences } from '@/lib/types'
import { statusForGmailMessage } from './lifecycle'

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
const GMAIL_RETRY_REQUIRED = 'Gmail sync has messages that need retry'

type ProcessedMessageResult = { imported: boolean; matched: boolean; statusUpdated: boolean; recommendations: number; retryNeeded: boolean }

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
      fetchRecentGmailMessages(accessToken, since, userId),
      db.job.findMany({
        where: { userId },
        select: { id: true, company: true, role: true, status: true },
      }),
    ])
    const orderedMessages = messages.sort((left, right) => left.receivedAt.getTime() - right.receivedAt.getTime())
    const result: GmailSyncResult = { ...EMPTY_RESULT, connected: true }
    let retryNeeded = false

    for (const message of orderedMessages) {
      const processed = await processMessage(userId, message, jobs, now, notificationPreferences)
      result.importedMessages += processed.imported ? 1 : 0
      result.matchedMessages += processed.matched ? 1 : 0
      result.statusUpdates += processed.statusUpdated ? 1 : 0
      result.newRecommendations += processed.recommendations
      retryNeeded ||= processed.retryNeeded
    }

    const cursorUpdate = retryNeeded ? { lastError: GMAIL_RETRY_REQUIRED } : { lastSyncedAt: now, lastError: null }
    result.error = retryNeeded ? GMAIL_RETRY_REQUIRED : null
    await db.gmailSyncState.update({ where: { userId }, data: cursorUpdate })
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
  jobs: Array<GmailMatchableJob>,
  now: Date,
  notificationPreferences: NotificationPreferences,
): Promise<ProcessedMessageResult> {
  const existing = await db.gmailMessage.findUnique({
    where: { userId_gmailMessageId: { userId, gmailMessageId: message.id } },
    select: { id: true, kind: true, scheduledAt: true },
  })
  if (existing) {
    if (existing.kind === 'interview_invitation' && !existing.scheduledAt) {
      const scheduledAt = extractInterviewSchedule(`${message.subject}\n${message.text}`, message.receivedAt)
      if (scheduledAt) await db.gmailMessage.update({ where: { id: existing.id }, data: { scheduledAt } })
    }
    return { imported: false, matched: false, statusUpdated: false, recommendations: 0, retryNeeded: false }
  }

  const kind = classifyGmailMessage({ subject: message.subject, excerpt: message.snippet, body: message.text })
  if (kind === 'other') return { imported: false, matched: false, statusUpdated: false, recommendations: 0, retryNeeded: false }

  const inferred = inferApplicationMetadata(message.subject)
  const match = findConfidentGmailJobMatch(jobs, {
    ...inferred,
    subject: message.subject,
    senderEmail: message.senderEmail,
  })
  const scheduledAt = kind === 'interview_invitation'
    ? extractInterviewSchedule(`${message.subject}\n${message.text}`, message.receivedAt)
    : null
  const trackedData = trackedMessageData(userId, message, kind, inferred, match?.job.id ?? null, match?.confidence ?? null, scheduledAt, now)
  if (match && statusForGmailMessage(kind)) {
    const projection = await trackAndProjectLinkedStatusMessage(
      userId, match.job, message.receivedAt, kind, notificationPreferences, trackedData,
    )
    if (projection.kind === 'duplicate') {
      return { imported: false, matched: false, statusUpdated: false, recommendations: 0, retryNeeded: false }
    }
    if (projection.kind === 'retry') {
      return { imported: false, matched: false, statusUpdated: false, recommendations: 0, retryNeeded: true }
    }
    return { imported: true, matched: true, statusUpdated: projection.statusUpdated, recommendations: 0, retryNeeded: false }
  }

  const tracked = await createTrackedMessage(trackedData)
  if (!tracked) return { imported: false, matched: false, statusUpdated: false, recommendations: 0, retryNeeded: false }

  const recommendations = kind === 'recommendation_digest'
    ? await persistRecommendations(userId, tracked.id, message)
    : 0
  if (!match) return { imported: true, matched: false, statusUpdated: false, recommendations, retryNeeded: false }

  await recordLinkedGmailEvent(userId, match.job, kind)
  return { imported: true, matched: true, statusUpdated: false, recommendations, retryNeeded: false }
}

function trackedMessageData(
  userId: string,
  message: GmailRemoteMessage,
  kind: GmailMessageKind,
  inferred: { company: string | null; role: string | null },
  jobId: string | null,
  matchConfidence: number | null,
  scheduledAt: Date | null,
  now: Date,
): GmailTrackedMessageData {
  return {
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
  }
}

async function createTrackedMessage(data: GmailTrackedMessageData) {
  try {
    return await db.gmailMessage.create({ data })
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
