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

  const { name, content, templateId, templateOptions, isDefault } = body

  if (isDefault && !existing.isDefault) {
    await db.resume.updateMany({
      where: { userId: auth.userId },
      data:  { isDefault: false },
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
