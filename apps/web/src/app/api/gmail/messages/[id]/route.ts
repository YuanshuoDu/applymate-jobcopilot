import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { err, isErrorResponse, ok, requireAuth } from '@/lib/api-helpers'
import { activityTypeForGmailMessage, canApplyGmailStatus, gmailEventLabel, statusForGmailMessage } from '@/lib/gmail-tracking/lifecycle'

type Params = { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { id } = await params
  const body = await req.json().catch(() => null)
  const action = typeof body?.action === 'string' ? body.action : ''
  const message = await db.gmailMessage.findFirst({ where: { id, userId: auth.userId } })
  if (!message) return err('Tracked Gmail message not found', 404)
  if (message.jobId) return ok({ message })

  const job = action === 'link'
    ? await findOwnedJob(auth.userId, body?.jobId)
    : action === 'create_job'
      ? await createJobFromMessage(auth.userId, message, { company: body?.company, role: body?.role })
      : null
  if (!job) return err(action === 'link' ? 'Job not found' : 'This email needs a company and role before it can be saved', 422)

  const projected = await projectMessageToJob(auth.userId, message, job)
  return ok(projected)
}

async function findOwnedJob(userId: string, jobId: unknown) {
  if (typeof jobId !== 'string') return null
  return db.job.findFirst({ where: { id: jobId, userId } })
}

async function createJobFromMessage(
  userId: string,
  message: { inferredCompany: string | null; inferredRole: string | null; kind: Parameters<typeof statusForGmailMessage>[0]; receivedAt: Date },
  details: { company?: unknown; role?: unknown },
) {
  const company = text(details.company) ?? message.inferredCompany
  const role = text(details.role) ?? message.inferredRole
  if (!company || !role) return null
  const status = statusForGmailMessage(message.kind) ?? 'saved'
  return db.job.create({
    data: {
      userId,
      company,
      role,
      source: 'gmail',
      status,
      workflowState: status === 'saved' ? 'draft' : 'submitted',
      ...(status === 'applied' ? { appliedAt: message.receivedAt } : {}),
    },
  })
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function projectMessageToJob(
  userId: string,
  message: {
    id: string
    kind: Parameters<typeof statusForGmailMessage>[0]
    receivedAt: Date
    subject: string
  },
  job: { id: string; company: string; role: string; status: Parameters<typeof canApplyGmailStatus>[0]; appliedAt: Date | null },
) {
  const nextStatus = statusForGmailMessage(message.kind)
  const shouldUpdate = Boolean(nextStatus && canApplyGmailStatus(job.status, nextStatus))
  const updatedJob = shouldUpdate && nextStatus
    ? await db.job.update({
      where: { id: job.id },
      data: {
        status: nextStatus,
        workflowState: 'submitted',
        ...(nextStatus === 'applied' && !job.appliedAt ? { appliedAt: message.receivedAt } : {}),
      },
    })
    : job

  const trackedMessage = await db.gmailMessage.update({
    where: { id: message.id },
    data: { jobId: job.id, matchConfidence: 1, manuallyLinked: true },
  })
  await db.activity.create({
    data: {
      userId,
      jobId: job.id,
      type: activityTypeForGmailMessage(message.kind),
      text: `Gmail ${gmailEventLabel(message.kind)} linked to ${job.company} · ${job.role}${shouldUpdate ? ` — status updated to ${nextStatus}` : ''}`,
      color: '#4F46E5',
    },
  })

  return { message: trackedMessage, job: updatedJob }
}
