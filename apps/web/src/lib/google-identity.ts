import { db } from '@/lib/db'
import { normalizeEmail } from '@/lib/auth-identifiers'

type GoogleProfile = {
  email?: unknown
  email_verified?: unknown
  name?: unknown
  picture?: unknown
}

type GoogleIdentityInput = {
  user: { email?: string | null }
  account: { provider?: string; providerAccountId?: string }
  profile?: GoogleProfile | null
}

function verifiedEmail(profile?: GoogleProfile | null): string | null {
  if (typeof profile?.email !== 'string' || profile.email_verified !== true) return null
  const email = normalizeEmail(profile.email)
  return email ? email : null
}

/**
 * Auth.js normally resolves an OAuth account by provider subject before it
 * looks at the verified profile email. If a legacy Gmail connection polluted
 * that mapping, a real Google identity can otherwise be signed into the demo
 * user. Repair only a verified mismatch before Auth.js creates the session.
 */
export async function reconcileGoogleLoginIdentity(input: GoogleIdentityInput): Promise<boolean> {
  if (input.account.provider !== 'google' || !input.account.providerAccountId) return true

  const email = verifiedEmail(input.profile)
  if (!email) return false

  const currentEmail = input.user.email ? normalizeEmail(input.user.email) : ''
  if (currentEmail === email) return true

  const name = typeof input.profile?.name === 'string' ? input.profile.name : null
  const image = typeof input.profile?.picture === 'string' ? input.profile.picture : null
  const target = await db.user.upsert({
    where: { email },
    update: {},
    create: { email, name, image, emailVerified: new Date() },
  })

  const targetGoogleAccount = await db.account.findFirst({
    where: { userId: target.id, provider: 'google' },
    select: { providerAccountId: true },
  })
  if (targetGoogleAccount && targetGoogleAccount.providerAccountId !== input.account.providerAccountId) {
    return false
  }

  const repaired = await db.account.updateMany({
    where: {
      provider: 'google',
      providerAccountId: input.account.providerAccountId,
    },
    data: { userId: target.id },
  })

  return repaired.count === 1
}
