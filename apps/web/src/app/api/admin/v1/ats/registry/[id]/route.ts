import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { parseAtsEmployerUpdate } from '@/lib/admin/ats-service'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { AdminMutationConflict, runAdminMutation } from '@/lib/admin/write-transaction'
import { db } from '@/lib/db'

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('ats.registry.manage', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const id = Number((await context.params).id)
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const update = parseAtsEmployerUpdate(body)
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  const key = request.headers.get('idempotency-key')?.trim() ?? ''
  if (!Number.isInteger(id) || id < 1 || !update || !key || reason.length < 10 || reason.length > 500) return NextResponse.json({ error: 'A valid employer update, reason and Idempotency-Key are required' }, { status: 400 })
  const current = await db.atsEmployer.findUnique({ where: { id }, select: { id: true, atsType: true, slug: true, name: true, country: true, enabled: true, version: true } })
  if (!current) return NextResponse.json({ error: 'ATS employer not found' }, { status: 404 })
  if (current.version !== update.version) return NextResponse.json({ error: 'This registry entry changed. Refresh and try again.' }, { status: 409 })
  const action = current.enabled !== update.enabled ? (update.enabled ? 'ats.registry_entry_enabled' : 'ats.registry_entry_disabled') : 'ats.registry_entry_updated'
  try {
    const result = await runAdminMutation({
      actorUserId: actor.userId,
      action,
      idempotencyKey: key,
      targetId: String(id),
      audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'ats_source', targetId: String(id), reason, outcome: 'success', before: current, after: { name: update.name, country: update.country, enabled: update.enabled, version: update.version + 1 } },
      mutate: async (tx) => {
        const changed = await tx.atsEmployer.updateMany({
          where: { id, version: update.version },
          data: { name: update.name, country: update.country, enabled: update.enabled, version: { increment: 1 } },
        })
        if (changed.count !== 1) throw new AdminMutationConflict('ATS registry entry changed during update')
        return tx.atsEmployer.findUniqueOrThrow({ where: { id } })
      },
    })
    if (result.duplicate) return NextResponse.json({ duplicate: true })
    return NextResponse.json({ employer: result.value }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
  } catch (error) {
    if (error instanceof AdminMutationConflict) return NextResponse.json({ error: 'This registry entry changed. Refresh and try again.' }, { status: 409 })
    throw error
  }
}
