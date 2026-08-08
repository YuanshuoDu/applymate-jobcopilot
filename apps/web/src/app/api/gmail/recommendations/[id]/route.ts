import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { err, isErrorResponse, ok, requireAuth } from '@/lib/api-helpers'
import { getGoogleAccessToken } from '@/lib/gmail-helpers'
import { hydrateRecommendationDetails } from '@/lib/gmail-tracking/recommendation-details'

type Params = { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { id } = await params
  const body = await req.json().catch(() => null)
  const action = isAction(body?.action) ? body.action : null
  if (!action) return err('Expected action "save" or "dismiss"')

  const recommendation = await db.gmailRecommendation.findFirst({
    where: { id, userId: auth.userId },
    include: { sourceMessage: { select: { gmailMessageId: true } } },
  })
  if (!recommendation) return err('Recommendation not found', 404)

  if (action === 'dismiss') {
    const updated = await db.gmailRecommendation.update({
      where: { id: recommendation.id },
      data: { status: 'dismissed' },
    })
    return ok({ recommendation: updated })
  }

  if (recommendation.status === 'saved' && recommendation.savedJobId) {
    return ok({ recommendation })
  }
  const token = await getGoogleAccessToken(auth.userId).catch(() => null)
  if (!token || !recommendation.sourceMessage?.gmailMessageId) return err('Reconnect Gmail to retrieve the job details before saving', 401)
  const details = await hydrateRecommendationDetails({ ...recommendation, gmailMessageId: recommendation.sourceMessage.gmailMessageId }, token, auth.userId)
  if (!details.company || !details.role || !hasJobDescription(details.description)) {
    return err('We could not retrieve a complete job description from the source email. Open the source email and retry after the job details are available.', 422)
  }

  const existingJob = details.url ? await db.job.findFirst({ where: { userId: auth.userId, url: details.url } }) : null
  const job = existingJob ?? await db.job.create({
    data: {
      userId: auth.userId, company: details.company, role: details.role, location: details.location,
      salary: details.salary, url: details.url, description: details.description, source: 'gmail', status: 'saved',
    },
  })
  const updated = await db.gmailRecommendation.update({
    where: { id: recommendation.id },
    data: { ...details, status: 'saved', savedJobId: job.id },
  })
  await db.activity.create({
    data: {
      userId: auth.userId,
      jobId: job.id,
      type: 'note_added',
      text: `Saved Gmail recommendation: ${job.company} · ${job.role}`,
      color: '#4F46E5',
    },
  })

  return ok({ recommendation: updated, job })
}

function isAction(value: unknown): value is 'save' | 'dismiss' {
  return value === 'save' || value === 'dismiss'
}

function hasJobDescription(value: string | null): value is string {
  return Boolean(value && value.replace(/\s/g, '').length >= 80)
}
