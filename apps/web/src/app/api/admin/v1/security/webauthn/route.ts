import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server'
import { AdminMfaLevel, AdminWebAuthnChallengePurpose } from '@prisma/client'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { isAdminResponse, requireAdminMembership } from '@/lib/admin/authorization'
import { requestIdFor, writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { credentialIdBytes, hashReauthToken, newChallenge, newReauthToken, setReauthCookie, webAuthnSettings, ADMIN_REAUTH_TTL_SECONDS, ADMIN_WEBAUTHN_CHALLENGE_TTL_MS, validTransports } from '@/lib/admin/webauthn'

type Payload = { action?: string; challengeId?: string; response?: unknown; deviceName?: string }

export async function GET(request: Request) {
  const actor = await requireAdminMembership(request)
  if (isAdminResponse(actor)) return actor
  const credentials = await db.adminWebAuthnCredential.findMany({ where: { userId: actor.userId, revokedAt: null }, orderBy: { createdAt: 'desc' }, select: { id: true, deviceName: true, deviceType: true, createdAt: true, lastUsedAt: true } })
  return NextResponse.json({ mfaLevel: credentials.length ? AdminMfaLevel.webauthn : AdminMfaLevel.none, credentials }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}

export async function POST(request: Request) {
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const actor = await requireAdminMembership(request)
  if (isAdminResponse(actor)) return actor
  const body = await request.json().catch(() => null) as Payload | null
  if (!body?.action) return NextResponse.json({ error: 'action is required' }, { status: 400 })
  try {
    if (body.action === 'register_options') return await registrationOptions(actor.userId, actor.requestId, request)
    if (body.action === 'register_verify') return await registrationVerify(actor.userId, actor.requestId, request, body)
    if (body.action === 'reauth_options') return await reauthenticationOptions(actor.userId, actor.requestId, request)
    if (body.action === 'reauth_verify') return await reauthenticationVerify(actor.userId, actor.requestId, request, body)
  } catch (error) {
    console.error('[admin-webauthn]', error)
    return NextResponse.json({ error: 'WebAuthn verification failed' }, { status: 400 })
  }
  return NextResponse.json({ error: 'Unsupported WebAuthn action' }, { status: 400 })
}

async function registrationOptions(userId: string, requestId: string, request: Request) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true, name: true } })
  if (!user) return NextResponse.json({ error: 'Administrator not found' }, { status: 404 })
  const existing = await db.adminWebAuthnCredential.findMany({ where: { userId, revokedAt: null }, select: { credentialId: true, transports: true } })
  const settings = webAuthnSettings(request)
  const options = await generateRegistrationOptions({
    rpName: settings.rpName,
    rpID: settings.rpID,
    userID: userId,
    userName: user.email,
    userDisplayName: user.name ?? user.email,
    timeout: 60_000,
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    excludeCredentials: existing.map((credential) => ({ id: credentialIdBytes(credential.credentialId), type: 'public-key' as const, transports: validTransports(credential.transports) })),
  })
  const challenge = await db.adminWebAuthnChallenge.create({ data: { userId, purpose: AdminWebAuthnChallengePurpose.registration, challenge: options.challenge, expiresAt: new Date(Date.now() + ADMIN_WEBAUTHN_CHALLENGE_TTL_MS) } })
  return NextResponse.json({ options, challengeId: challenge.id }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': requestId } })
}

async function registrationVerify(userId: string, requestId: string, request: Request, body: Payload) {
  if (!body.challengeId || !isWebAuthnResponse(body.response)) return NextResponse.json({ error: 'Invalid registration response' }, { status: 400 })
  const challenge = await activeChallenge(userId, body.challengeId, AdminWebAuthnChallengePurpose.registration)
  if (!challenge) return NextResponse.json({ error: 'Registration challenge expired' }, { status: 409 })
  const settings = webAuthnSettings(request)
  const verification = await verifyRegistrationResponse({ response: body.response as Parameters<typeof verifyRegistrationResponse>[0]['response'], expectedChallenge: challenge.challenge, expectedOrigin: settings.origin, expectedRPID: settings.rpID, requireUserVerification: true })
  if (!verification.verified || !verification.registrationInfo) return NextResponse.json({ error: 'Authenticator could not be verified' }, { status: 400 })
  const info = verification.registrationInfo
  await db.$transaction([
    db.adminWebAuthnCredential.create({ data: { userId, credentialId: Buffer.from(info.credentialID).toString('base64url'), publicKey: Buffer.from(info.credentialPublicKey), counter: info.counter, transports: [], deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp, deviceName: typeof body.deviceName === 'string' ? body.deviceName.trim().slice(0, 80) || null : null } }),
    db.adminMembership.update({ where: { userId }, data: { mfaLevel: AdminMfaLevel.webauthn } }),
    db.adminWebAuthnChallenge.update({ where: { id: challenge.id }, data: { usedAt: new Date() } }),
  ])
  await writeAdminAudit({ requestId, actorUserId: userId, action: 'admin.webauthn.registered', outcome: 'success', targetId: userId, ip: request.headers.get('x-forwarded-for'), userAgent: request.headers.get('user-agent') })
  return NextResponse.json({ verified: true }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': requestId } })
}

async function reauthenticationOptions(userId: string, requestId: string, request: Request) {
  const credentials = await db.adminWebAuthnCredential.findMany({ where: { userId, revokedAt: null }, select: { credentialId: true, transports: true } })
  if (!credentials.length) return NextResponse.json({ error: 'Register a security key before reauthenticating' }, { status: 409 })
  const settings = webAuthnSettings(request)
  const options = await generateAuthenticationOptions({ rpID: settings.rpID, timeout: 60_000, userVerification: 'required', allowCredentials: credentials.map((credential) => ({ id: credentialIdBytes(credential.credentialId), type: 'public-key' as const, transports: validTransports(credential.transports) })) })
  const challenge = await db.adminWebAuthnChallenge.create({ data: { userId, purpose: AdminWebAuthnChallengePurpose.reauthentication, challenge: options.challenge, expiresAt: new Date(Date.now() + ADMIN_WEBAUTHN_CHALLENGE_TTL_MS) } })
  return NextResponse.json({ options, challengeId: challenge.id }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': requestId } })
}

async function reauthenticationVerify(userId: string, requestId: string, request: Request, body: Payload) {
  if (!body.challengeId || !isWebAuthnResponse(body.response)) return NextResponse.json({ error: 'Invalid authentication response' }, { status: 400 })
  const challenge = await activeChallenge(userId, body.challengeId, AdminWebAuthnChallengePurpose.reauthentication)
  if (!challenge) return NextResponse.json({ error: 'Authentication challenge expired' }, { status: 409 })
  const credential = await db.adminWebAuthnCredential.findFirst({ where: { userId, credentialId: body.response.id, revokedAt: null } })
  if (!credential) return NextResponse.json({ error: 'Unknown security key' }, { status: 403 })
  const settings = webAuthnSettings(request)
  const verification = await verifyAuthenticationResponse({ response: body.response as Parameters<typeof verifyAuthenticationResponse>[0]['response'], expectedChallenge: challenge.challenge, expectedOrigin: settings.origin, expectedRPID: settings.rpID, requireUserVerification: true, authenticator: { credentialID: credentialIdBytes(credential.credentialId), credentialPublicKey: new Uint8Array(credential.publicKey), counter: credential.counter } })
  if (!verification.verified || verification.authenticationInfo.newCounter < credential.counter) return NextResponse.json({ error: 'Authenticator counter validation failed' }, { status: 403 })
  const now = new Date()
  const token = newReauthToken()
  const updated = await db.$transaction([
    db.adminWebAuthnCredential.updateMany({ where: { id: credential.id, counter: credential.counter }, data: { counter: verification.authenticationInfo.newCounter, lastUsedAt: now } }),
    db.adminWebAuthnChallenge.updateMany({ where: { id: challenge.id, usedAt: null }, data: { usedAt: now } }),
    db.adminReauthGrant.create({ data: { userId, tokenHash: hashReauthToken(token), expiresAt: new Date(now.getTime() + ADMIN_REAUTH_TTL_SECONDS * 1000) } }),
  ])
  if (updated[0].count !== 1 || updated[1].count !== 1) return NextResponse.json({ error: 'Authentication was already used' }, { status: 409 })
  const response = NextResponse.json({ verified: true, expiresAt: new Date(now.getTime() + ADMIN_REAUTH_TTL_SECONDS * 1000).toISOString() }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': requestId } })
  setReauthCookie(response, token)
  await writeAdminAudit({ requestId, actorUserId: userId, action: 'admin.webauthn.reauthenticated', outcome: 'success', targetId: credential.id, ip: request.headers.get('x-forwarded-for'), userAgent: request.headers.get('user-agent') })
  return response
}

async function activeChallenge(userId: string, id: string, purpose: AdminWebAuthnChallengePurpose) {
  return db.adminWebAuthnChallenge.findFirst({ where: { id, userId, purpose, usedAt: null, expiresAt: { gt: new Date() } } })
}

function isWebAuthnResponse(value: unknown): value is { id: string } {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string' && 'response' in value
}
