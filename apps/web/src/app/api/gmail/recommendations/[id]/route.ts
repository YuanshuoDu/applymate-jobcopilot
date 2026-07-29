import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { err, isErrorResponse, ok, requireAuth } from '@/lib/api-helpers'

type Params = { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { id } = await params
  const body = await req.json().catch(() => null)
  const action = isAction(body?.action) ? body.action : null
  if (!action) return err('Expected action "save" or "dismiss"')

  const recommendation = await db.gmailRecommendation.findFirst({ where: { id, userId: auth.userId } })
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
  if (!recommendation.company || !recommendation.role) {
    return err('This recommendation needs a company and role before it can be saved', 422)
  }

  const job = await db.job.create({
    data: {
      userId: auth.userId,
      company: recommendation.company,
      role: recommendation.role,
      location: recommendation.location,
      salary: recommendation.salary,
      url: recommendation.url,
      description: recommendation.description,
      source: 'gmail',
      status: 'saved',
    },
  })
  const updated = await db.gmailRecommendation.update({
    where: { id: recommendation.id },
    data: { status: 'saved', savedJobId: job.id },
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
