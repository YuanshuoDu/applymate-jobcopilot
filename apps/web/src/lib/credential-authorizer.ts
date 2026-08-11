import bcrypt from 'bcryptjs'
import { AdminMembershipStatus } from '@prisma/client'
import { jwtVerify } from 'jose'
import { db } from '@/lib/db'
import { normalizeEmail } from '@/lib/auth-identifiers'
import { EXTENSION_TOKEN_AUDIENCE, EXTENSION_TOKEN_ISSUER, getAuthJwtSecret } from '@/lib/auth-secret'
import { isCurrentAuthVersion } from '@/lib/auth-version'
import { isAdminHost } from '@/lib/host-routing'

const JWT_SECRET = getAuthJwtSecret()

type Credentials = Partial<Record<'email' | 'password' | 'token', unknown>>

function isAdministratorRequest(request: Request): boolean {
  try {
    return isAdminHost(new URL(request.url).hostname)
  } catch {
    return true
  }
}

export async function authorizeCredentials(credentials: Credentials, request: Request) {
  const onAdministratorHost = isAdministratorRequest(request)

  if (credentials.token && typeof credentials.token === 'string') {
    if (onAdministratorHost) return null
    try {
      const { payload } = await jwtVerify(credentials.token, JWT_SECRET, {
        issuer: EXTENSION_TOKEN_ISSUER,
        audience: EXTENSION_TOKEN_AUDIENCE,
      })
      if (typeof payload.sub !== 'string' || !payload.sub) return null
      const user = await db.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, email: true, name: true, image: true, accountStatus: true, authVersion: true },
      })
      if (!user || user.accountStatus !== 'active' || !isCurrentAuthVersion(payload.authVersion, user.authVersion)) return null
      return { id: user.id, email: user.email, name: user.name, image: user.image }
    } catch {
      return null
    }
  }

  if (!credentials.email || !credentials.password) return null
  const email = normalizeEmail(credentials.email as string)
  if (!email) return null
  const user = await db.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, email: true, name: true, image: true, password: true, accountStatus: true },
  })
  if (!user?.password || user.accountStatus !== 'active') return null
  const valid = await bcrypt.compare(credentials.password as string, user.password)
  if (!valid) return null

  if (onAdministratorHost) {
    const membership = await db.adminMembership.findUnique({
      where: { userId: user.id },
      select: { status: true },
    })
    if (membership?.status !== AdminMembershipStatus.active) return null
  }

  return { id: user.id, email: user.email, name: user.name, image: user.image }
}
