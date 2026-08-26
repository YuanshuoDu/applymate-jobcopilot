import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { parseAtsEmployerRegistration } from '@/lib/admin/ats-service'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { runAdminMutation } from '@/lib/admin/write-transaction'

export async function POST(request: NextRequest) {
  const actor = await requireAdmin('ats.registry.manage', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const employer = parseAtsEmployerRegistration(body)
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  const key = request.headers.get('idempotency-key')?.trim() ?? ''
  if (!employer || !key || reason.length < 10 || reason.length > 500) return NextResponse.json({ error: 'A valid ATS employer, reason and Idempotency-Key are required' }, { status: 400 })
  const targetId = `${employer.atsType}:${employer.slug}`
  try {
    const result = await runAdminMutation({
      actorUserId: actor.userId,
      action: 'ats.registry_entry_created',
      idempotencyKey: key,
      targetId,
      audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'ats_source', targetId, reason, outcome: 'success', after: employer },
      mutate: (tx) => tx.atsEmployer.create({ data: employer }),
    })
    if (result.duplicate) return NextResponse.json({ duplicate: true })
    return NextResponse.json({ employer: result.value }, { status: 201, headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') return NextResponse.json({ error: 'This ATS employer is already registered' }, { status: 409 })
    throw error
  }
}
