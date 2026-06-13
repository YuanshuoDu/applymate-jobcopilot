/**
 * GET  /api/resume  — list resumes for current user
 * POST /api/resume  — create a new resume
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'

export async function GET() {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const resumes = await db.resume.findMany({
    where: { userId: auth.userId },
    orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    select: {
      id: true, name: true, isDefault: true,
      directionId: true, kind: true, parentResumeId: true,
      targetJobId: true, origin: true, basicsDetached: true,
      createdAt: true, updatedAt: true,
      _count: { select: { finalForJobs: true } },
    },
  })

  return ok(resumes)
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { name, content, templateId, isDefault, directionId, kind, origin } = body
  if (!name || !content) return err('name and content are required')

  if (directionId) {
    const dir = await db.direction.findFirst({ where: { id: directionId, userId: auth.userId } })
    if (!dir) return err('Invalid directionId', 400)
  }

  // If setting as default, unset others
  if (isDefault) {
    await db.resume.updateMany({
      where: { userId: auth.userId },
      data:  { isDefault: false },
    })
  }

  const resume = await db.resume.create({
    data: {
      userId:      auth.userId,
      name,
      content,
      templateId:  templateId  ?? null,
      isDefault:   isDefault   ?? false,
      directionId: directionId ?? null,
      kind:        kind        ?? 'base',
      origin:      origin      ?? 'manual',
    },
  })

  return ok(resume, 201)
}
