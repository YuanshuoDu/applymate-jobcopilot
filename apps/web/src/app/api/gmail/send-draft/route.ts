/**
 * POST /api/gmail/send-draft
 * Sends a user-confirmed follow-up via Gmail and records it against a matched job.
 * Body: { to, subject, draft, gmailMessageId?, threadId?, jobId? }
 */
import { NextRequest }                          from 'next/server'
import { randomUUID }                           from 'node:crypto'
import { trackedExternalApiFetch }                from '@/lib/api-usage/external-api-usage'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { getGoogleAccessToken }                  from '@/lib/gmail-helpers'
import { db }                                    from '@/lib/db'
import { createAgentSession, appendTranscriptEvent } from '@/lib/agent/session/repository'
import { ensureV2Turn }                           from '@/lib/agent/session/v2-turn'
import { clientReceipt, consumeLegacyReceipt, issueLegacyReceipt, resolveLegacyApproval, validateLegacyReceipt } from '@/lib/agent/approval/legacy-receipt'
import { requireLegacyPolicy }                    from '@/lib/agent/policy/legacy'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return err('Missing email draft', 400)

  const { to, subject, draft, jobId, gmailMessageId, threadId, messageKind, approvalId, receiptNonce, sessionId } = body as {
    to?: unknown; subject?: unknown; draft?: unknown; jobId?: unknown; gmailMessageId?: unknown; threadId?: unknown; messageKind?: unknown
    approvalId?: unknown; receiptNonce?: unknown; sessionId?: unknown
  }
  if (typeof to !== 'string' || !to.trim() || typeof draft !== 'string' || !draft.trim()) return err('Missing to or draft', 400)
  if (draft.length > 50_000) return err('Draft is too large', 400)
  const normalizedSubject = typeof subject === 'string' && subject.trim() ? subject.trim() : 'Following up on my application'
  const normalizedJobId = typeof jobId === 'string' && jobId ? jobId : undefined
  const normalizedMessageId = typeof gmailMessageId === 'string' && gmailMessageId ? gmailMessageId : undefined
  const normalizedThreadId = typeof threadId === 'string' && threadId ? threadId : undefined
  const matchedJob = await findFollowUpJob(auth.userId, normalizedJobId, normalizedMessageId)
  if (!matchedJob) return err('Link this email to one of your tracked jobs before sending a follow-up.', 409)
  const token = await getGoogleAccessToken(auth.userId)
  if (!token) return err('Gmail not connected. Please connect Google account in Settings.')

  if (typeof approvalId !== 'string' || typeof receiptNonce !== 'string' || typeof sessionId !== 'string') {
    return createSendApproval(auth.userId, matchedJob.id, {
      to: to.trim(), subject: normalizedSubject, draft, gmailMessageId: normalizedMessageId, threadId: normalizedThreadId, messageKind,
    })
  }

  const approval = await db.agentApproval.findFirst({
    where: { id: approvalId, sessionId, userId: auth.userId, status: 'pending', type: 'send_gmail' },
    select: { id: true, type: true, payload: true, turnId: true, toolCallId: true, jobId: true, revision: true, expiresAt: true },
  })
  if (!approval || approval.jobId !== matchedJob.id || !approval.turnId || !approval.toolCallId || !approval.expiresAt) return err('The Gmail approval is no longer valid.', 409)
  try {
    requireLegacyPolicy({
      userId: auth.userId, sessionId, turnId: approval.turnId, stepId: `gmail:${approval.id}`, toolCallId: approval.toolCallId,
      toolName: 'gmail.send', domain: 'gmail', risk: 'external_write', capabilities: ['read', 'write', 'external_write'],
      input: { requiresReceipt: true, receiptValidated: true, unknownSensitiveFacts: false },
    })
    await validateLegacyReceipt(db, {
      approvalId: approval.id, userId: auth.userId, sessionId, turnId: approval.turnId, toolCallId: approval.toolCallId, jobId: matchedJob.id,
      action: 'send_gmail', nonce: receiptNonce, resource: { jobId: matchedJob.id, gmailMessageId: normalizedMessageId, threadId: normalizedThreadId },
      material: { to: to.trim(), subject: normalizedSubject, draft }, answers: null, revision: approval.revision, expiresAt: approval.expiresAt,
    })
    await resolveLegacyApproval(db, { approval, userId: auth.userId, sessionId, decision: 'approved' })
    await db.agentTurn.update({ where: { id: approval.turnId }, data: { status: 'in_progress' } })
    await consumeLegacyReceipt(db, {
      approvalId: approval.id, userId: auth.userId, sessionId, turnId: approval.turnId, toolCallId: approval.toolCallId, jobId: matchedJob.id,
      action: 'send_gmail', nonce: receiptNonce, resource: { jobId: matchedJob.id, gmailMessageId: normalizedMessageId, threadId: normalizedThreadId },
      material: { to: to.trim(), subject: normalizedSubject, draft }, answers: null, revision: approval.revision, expiresAt: approval.expiresAt,
      reservationKey: `gmail-send:${approval.id}`,
    })
  } catch (error) {
    return err(error instanceof Error ? error.message : 'The Gmail approval could not be consumed.', 409)
  }

  // Build RFC 2822 message
  const fromRes = await trackedExternalApiFetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${token}` },
  }, { provider: 'gmail', operation: 'profile', credentialSource: 'user', userId: auth.userId })
  const profile = fromRes.ok ? await fromRes.json() as { emailAddress?: string } : {}
  const from = profile.emailAddress ?? 'me'

  const messageParts = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${normalizedSubject}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    draft,
  ]
  const raw = Buffer.from(messageParts.join('\r\n')).toString('base64url')

  const sendRes = await trackedExternalApiFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ raw, ...(typeof threadId === 'string' && threadId ? { threadId } : {}) }),
  }, { provider: 'gmail', operation: 'send_message', credentialSource: 'user', userId: auth.userId })

  if (!sendRes.ok) {
    return err(`Gmail send failed (HTTP ${sendRes.status})`, 500)
  }

  if (matchedJob) await db.$transaction(async tx => {
    await tx.job.update({ where: { id: matchedJob.id }, data: { followUpAt: null } })
    await tx.activity.create({
      data: {
        userId: auth.userId,
        jobId: matchedJob.id,
        type: 'email_sent',
        text: `Follow-up email sent${typeof messageKind === 'string' && messageKind ? ` · ${messageKind.replace(/_/g, ' ')}` : ''}`,
        color: '#7C3AED',
      },
    })
  })

  return ok({ sent: true, to: to.trim(), tracked: Boolean(matchedJob), jobId: matchedJob.id })
}

async function createSendApproval(userId: string, jobId: string, input: { to: string; subject: string; draft: string; gmailMessageId?: string; threadId?: string; messageKind?: unknown }) {
  const session = await createAgentSession(db, { userId, goal: `Confirm Gmail follow-up for job ${jobId}`, source: 'manual_run' }) as { id: string }
  const turn = await ensureV2Turn(db, { sessionId: session.id, userId, goal: `Confirm Gmail follow-up for job ${jobId}`, source: 'user' })
  const currentTurn = await db.agentTurn.findFirst({ where: { id: turn.turnId, sessionId: session.id, userId }, select: { revision: true } })
  const result = await issueLegacyReceipt(db, {
    userId, sessionId: session.id, turnId: turn.turnId, toolCallId: `gmail-send:${randomUUID()}`, jobId, action: 'send_gmail',
    title: 'Confirm Gmail follow-up', body: 'Review the recipient, subject, and draft. Gmail will send only after this explicit confirmation.',
    impact: { externalSubmission: true, channel: 'gmail', jobId },
    payload: { jobId, gmailMessageId: input.gmailMessageId ?? null, threadId: input.threadId ?? null, messageKind: typeof input.messageKind === 'string' ? input.messageKind : null },
    resource: { jobId, gmailMessageId: input.gmailMessageId ?? null, threadId: input.threadId ?? null },
    material: { to: input.to, subject: input.subject, draft: input.draft }, answers: null, revision: currentTurn?.revision ?? 0,
  })
  await appendTranscriptEvent(db, {
    sessionId: session.id, type: 'approval_request', speaker: 'Reviewer', title: result.approval.title, body: result.approval.body,
    data: { approval: clientReceipt(result, { externalSubmission: true, channel: 'gmail', jobId }) },
  })
  return ok({ sent: false, approvalRequired: true, sessionId: session.id, approval: clientReceipt(result, { externalSubmission: true, channel: 'gmail', jobId }) }, 202)
}

async function findFollowUpJob(userId: string, requestedJobId: unknown, gmailMessageId: unknown) {
  if (typeof requestedJobId === 'string' && requestedJobId) {
    return db.job.findFirst({ where: { id: requestedJobId, userId }, select: { id: true } })
  }
  if (typeof gmailMessageId !== 'string' || !gmailMessageId) return null
  const message = await db.gmailMessage.findFirst({
    where: { userId, gmailMessageId, jobId: { not: null } },
    select: { job: { select: { id: true } } },
  })
  return message?.job ?? null
}
