/**
 * GET  /api/resume/:id/versions — list version history
 * POST /api/resume/:id/versions — restore a version (body: { versionId })
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

  const versions = await db.resumeVersion.findMany({
    where: { resumeId: id },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, name: true, createdAt: true },
  })

  return ok(versions)
}

export async function POST(req: NextRequest, { params }: Params) {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const { id } = await params
  const resume = await db.resume.findUnique({ where: { id } })
  if (!resume || resume.userId !== auth.userId) return err('Not found', 404)

  const body = await req.json().catch(() => null)
  const versionId: string | undefined = body?.versionId
  if (!versionId) return err('versionId is required')

  const version = await db.resumeVersion.findUnique({ where: { id: versionId } })
  if (!version || version.resumeId !== id) return err('Version not found', 404)

  // Snapshot current state before restoring (allows undo)
  await db.resumeVersion.create({
    data: {
      resumeId: id,
      userId: auth.userId,
      content: resume.content as object,
      name: resume.name,
    },
  })

  // Restore: update resume content from the version snapshot
  const updated = await db.resume.update({
    where: { id },
    data: { content: version.content as object, name: version.name },
  })

  return ok(updated)
}
