import { createHash } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { normalizeEmail } from '@/lib/auth-identifiers'
import { checkAuthRateLimit } from '@/lib/auth-rate-limit'
import { isAdminHost, isLocalHost } from '@/lib/host-routing'
import { createAdminAuditData, requestIdFor } from '@/lib/admin/audit'

/**
 * Create the ordinary ApplyMate account required to accept an administrator
 * invitation. The invitation token is the only authority for this public
 * bootstrap operation; no administrator session is accepted or required.
 */
export async function POST(request: NextRequest) {
  if (!isAdminHost(request.nextUrl.hostname) && !isLocalHost(request.nextUrl.hostname)) {
    return NextResponse.json(
      { error: 'Administrator API is only available on the administrator host' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  const body = await request.json().catch(() => null) as {
    token?: unknown
    email?: unknown
    name?: unknown
    password?: unknown
  } | null
  const token = typeof body?.token === 'string' ? body.token.trim() : ''
  const email = typeof body?.email === 'string' ? normalizeEmail(body.email) : ''
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const password = typeof body?.password === 'string' ? body.password : ''

  if (token.length < 20 || !/^\S+@\S+\.\S+$/.test(email) || email.length > 320 || !name || name.length > 120 || password.length < 8 || password.length > 256) {
    return NextResponse.json({ error: 'Invalid invitation registration details' }, { status: 400 })
  }

  const rate = await checkAuthRateLimit(request, 'admin-invite-register', email, { ipLimit: 5, identityLimit: 3, windowMs: 60 * 60_000 })
  if (!rate.ok) {
    return NextResponse.json({ error: rate.unavailable ? 'Authentication service temporarily unavailable' : 'Too many requests — retry later' }, { status: rate.unavailable ? 503 : 429 })
  }

  const tokenHash = createHash('sha256').update(token).digest('hex')
  const invitation = await db.adminInvitation.findUnique({
    where: { tokenHash },
    select: { id: true, email: true, status: true, expiresAt: true },
  })
  if (!invitation || normalizeEmail(invitation.email) !== email || invitation.status !== 'pending' || invitation.expiresAt <= new Date()) {
    return NextResponse.json({ error: 'Invitation is invalid or expired' }, { status: 400 })
  }

  const existing = await db.user.findMany({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true },
    take: 2,
  })
  if (existing.length > 0) {
    return NextResponse.json({ error: 'An account already exists for this invitation email', code: 'ACCOUNT_EXISTS' }, { status: 409 })
  }

  const passwordHash = await bcrypt.hash(password, 12)
  const requestId = requestIdFor(request)
  try {
    const user = await db.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { email, name, password: passwordHash },
        select: { id: true, email: true, name: true },
      })
      await tx.adminAuditLog.create({
        data: createAdminAuditData({
          requestId,
          actorUserId: created.id,
          action: 'admin_invitation.account_created',
          outcome: 'success',
          targetType: 'admin_member',
          targetId: created.id,
          reason: 'Created account from an administrator invitation',
          after: { invitationId: invitation.id },
          ip: request.headers.get('x-forwarded-for'),
          userAgent: request.headers.get('user-agent'),
        }),
      })
      return created
    })

    return NextResponse.json({ created: true, user }, { status: 201, headers: { 'Cache-Control': 'no-store', 'x-request-id': requestId } })
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
      return NextResponse.json({ error: 'An account already exists for this invitation email', code: 'ACCOUNT_EXISTS' }, { status: 409 })
    }
    throw error
  }
}
