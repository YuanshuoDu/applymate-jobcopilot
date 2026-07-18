/**
 * GET    /api/resume/:id  — get full resume content
 * PATCH  /api/resume/:id  — update resume
 * DELETE /api/resume/:id  — delete resume
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'

type Params = { params: Promise<{ id: string }> }

export async function GET(_req: NextRequest, { params }: Params) {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const { id } = await params
  const resume = await db.resume.findUnique({ where: { id } })
  if (!resume || resume.userId !== auth.userId) return err('Not found', 404)

  return ok(resume)
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const { id } = await params
  const existing = await db.resume.findUnique({ where: { id } })
  if (!existing || existing.userId !== auth.userId) return err('Not found', 404)

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { name, content, templateId, templateOptions, isDefault, targetJobId, unlinkJob } = body

  if (targetJobId !== undefined && targetJobId !== null) {
    const job = await db.job.findFirst({ where: { id: targetJobId, userId: auth.userId } })
    if (!job) return err('Invalid job', 400)
  }

  // Auto-create a version snapshot only if content actually changed
  const contentChanged = content !== undefined && JSON.stringify(content) !== JSON.stringify(existing.content)
  if (contentChanged) {
    await db.resumeVersion.create({
      data: {
        resumeId: id,
        userId: auth.userId,
        content: existing.content as object,
        name: existing.name,
      },
    })
    // Keep only the last 20 versions
    const oldVersions = await db.resumeVersion.findMany({
      where: { resumeId: id },
      orderBy: { createdAt: 'desc' },
      skip: 20,
      select: { id: true },
    })
    if (oldVersions.length > 0) {
      await db.resumeVersion.deleteMany({
        where: { id: { in: oldVersions.map(v => v.id) } },
      })
    }
  }

  if (isDefault && !existing.isDefault) {
    await db.resume.updateMany({
      where: { userId: auth.userId },
      data:  { isDefault: false },
    })
  }

  if (unlinkJob) {
    await db.job.updateMany({
      where: { userId: auth.userId, finalResumeId: id },
      data:  { finalResumeId: null },
    })
  }

  const resume = await db.resume.update({
    where: { id },
    data: {
      ...(name            !== undefined ? { name }            : {}),
      ...(content         !== undefined ? { content }         : {}),
      ...(templateId      !== undefined ? { templateId }      : {}),
      ...(templateOptions !== undefined ? { templateOptions } : {}),
      ...(isDefault       !== undefined ? { isDefault }       : {}),
      ...(unlinkJob || targetJobId !== undefined ? { targetJobId: unlinkJob ? null : targetJobId } : {}),
    },
  })

  return ok(resume)
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const { id } = await params
  const existing = await db.resume.findUnique({ where: { id } })
  if (!existing || existing.userId !== auth.userId) return err('Not found', 404)

  await db.resume.delete({ where: { id } })
  return ok({ deleted: true })
}
