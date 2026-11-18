import type { JobStatus, Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { acquireSourceMaterialFence } from '@/lib/agent/source-material-fence'
import { purgeTemporaryGeneratedCoverLetters } from '@/lib/cover-letter-retention'
import type { NotificationPreferences } from '@/lib/types'
import type { GmailMessageKind } from './classification'
import {
  activityTypeForGmailMessage,
  canApplyGmailStatus,
  gmailEventLabel,
  statusForGmailMessage,
} from './lifecycle'
import type { GmailMatchableJob } from './matching'

export type GmailTrackedMessageData = Omit<
  Prisma.GmailMessageUncheckedCreateInput,
  'id' | 'createdAt' | 'updatedAt'
>

type ScopedJob = {
  id: string
  company: string
  role: string
  status: JobStatus
  workflowState: string
  appliedAt: Date | null
}

type ProjectionResult = {
  job: ScopedJob | null
  statusUpdated: boolean
}

export type GmailStatusProjectionOutcome =
  | { kind: 'tracked'; statusUpdated: boolean }
  | { kind: 'duplicate' }
  | { kind: 'retry'; reason: 'cas_miss' | 'transaction_error' }

const STATUS_CAS_LOST = Symbol('gmail status compare-and-set lost')

/** Atomically records a status-bearing matched message with its fenced Job projection. */
export async function trackAndProjectLinkedStatusMessage(
  userId: string,
  matchedJob: GmailMatchableJob,
  receivedAt: Date,
  kind: GmailMessageKind,
  notificationPreferences: NotificationPreferences,
  trackedMessage: GmailTrackedMessageData,
): Promise<GmailStatusProjectionOutcome> {
  const nextStatus = statusForGmailMessage(kind)
  if (!nextStatus) throw new TypeError('Gmail status projection requires a status-bearing message kind')

  let projection: ProjectionResult
  try {
    projection = await db.$transaction(async tx => {
      await acquireSourceMaterialFence(tx, [userId])
      const current = await tx.job.findFirst({
        where: { id: matchedJob.id, userId },
        select: { id: true, company: true, role: true, status: true, workflowState: true, appliedAt: true },
      })

      let statusUpdated = false
      if (current && canApplyGmailStatus(current.status, nextStatus)) {
        const update = await tx.job.updateMany({
          where: {
            id: current.id,
            userId,
            status: current.status,
            workflowState: current.workflowState,
            appliedAt: current.appliedAt,
          },
          data: {
            status: nextStatus,
            workflowState: 'submitted',
            ...(nextStatus === 'applied' && !current.appliedAt ? { appliedAt: receivedAt } : {}),
          },
        })
        if (update.count !== 1) throw STATUS_CAS_LOST
        statusUpdated = true
      }

      await tx.gmailMessage.create({
        data: current ? trackedMessage : { ...trackedMessage, jobId: null, matchConfidence: null },
      })
      return { job: current, statusUpdated }
    })
  } catch (error) {
    if (error === STATUS_CAS_LOST) return { kind: 'retry', reason: 'cas_miss' }
    if (isUniqueConstraintError(error)) return { kind: 'duplicate' }
    return { kind: 'retry', reason: 'transaction_error' }
  }

  if (projection.job) {
    if (projection.statusUpdated && nextStatus === 'applied') {
      await purgeTemporaryGeneratedCoverLetters(userId, projection.job.id).catch(() => undefined)
    }
    const statusSuffix = projection.statusUpdated ? ' — status updated to ' + nextStatus : ''
    await db.activity.create({
      data: {
        userId,
        jobId: projection.job.id,
        type: activityTypeForGmailMessage(kind),
        text: 'Gmail ' + gmailEventLabel(kind) + ' from ' + projection.job.company + ' for ' + projection.job.role + statusSuffix,
        color: colorForGmailKind(kind),
      },
    })
    if (projection.statusUpdated) {
      await createStatusNotification(userId, projection.job.id, projection.job.company, projection.job.role, kind, notificationPreferences)
    }
  }
  return { kind: 'tracked', statusUpdated: projection.statusUpdated }
}

/** Records activity for a matched message that carries no Job status transition. */
export async function recordLinkedGmailEvent(
  userId: string,
  matchedJob: GmailMatchableJob,
  kind: GmailMessageKind,
): Promise<void> {
  if (statusForGmailMessage(kind)) throw new TypeError('Status-bearing Gmail messages must use the atomic projection')
  await db.activity.create({
    data: {
      userId,
      jobId: matchedJob.id,
      type: activityTypeForGmailMessage(kind),
      text: 'Gmail ' + gmailEventLabel(kind) + ' from ' + matchedJob.company + ' for ' + matchedJob.role,
      color: colorForGmailKind(kind),
    },
  })
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
      title: company + ': ' + gmailEventLabel(kind),
      body: role,
    },
  }).catch(() => undefined)
}

function gmailPreferenceKey(kind: GmailMessageKind): keyof NotificationPreferences {
  if (kind === 'rejection') return 'reject'
  if (kind === 'interview_invitation') return 'interview'
  if (kind === 'offer') return 'offer'
  return 'apply'
}

function colorForGmailKind(kind: GmailMessageKind): string {
  if (kind === 'rejection') return '#DC2626'
  if (kind === 'offer') return '#0284C7'
  if (kind === 'interview_invitation') return '#059669'
  return '#4F46E5'
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}
