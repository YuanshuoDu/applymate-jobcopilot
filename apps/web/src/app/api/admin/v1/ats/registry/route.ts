import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { isAtsSourceKey } from '@/lib/admin/ats-service'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { db } from '@/lib/db'

export async function POST(request: NextRequest) {
  const actor = await requireAdmin('ats.registry.manage', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const body = await request.json().catch(() => null) as { atsType?: string; slug?: string; name?: string; reason?: string } | null
  const atsType = typeof body?.atsType === 'string' ? body.atsType.trim().toLowerCase() : ''
  const slug = typeof body?.slug === 'string' ? body.slug.trim().toLowerCase() : ''
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 160) : null
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  const key = request.headers.get('idempotency-key')?.trim() ?? ''
  if (!isAtsSourceKey(atsType) || !/^[a-z0-9][a-z0-9._-]{1,100}$/.test(slug) || !key || reason.length < 10 || reason.length > 500) return NextResponse.json({ error: 'Invalid ATS employer registry entry' }, { status: 400 })
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'ats.registry_entry_created', idempotencyKey: key, targetId: `${atsType}:${slug}`, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'ats_source', targetId: `${atsType}:${slug}`, reason, outcome: 'success', after: { atsType, slug, name } }, mutate: (tx) => tx.atsEmployer.create({ data: { atsType, slug, name } }) })
  if (result.duplicate) return NextResponse.json({ duplicate: true })
  return NextResponse.json({ employer: result.value }, { status: 201, headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
