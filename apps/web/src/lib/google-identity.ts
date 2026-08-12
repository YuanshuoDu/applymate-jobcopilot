import { db } from '@/lib/db'
import { normalizeEmail } from '@/lib/auth-identifiers'

type GoogleProfile = {
  email?: unknown
  email_verified?: unknown
  name?: unknown
  picture?: unknown
}

type GoogleIdentityInput = {
  user: {
    id?: string
    email?: string | null
    name?: string | null
    image?: string | null
  }
  account: { provider?: string; providerAccountId?: string }
  profile?: GoogleProfile | null
}

type GoogleTargetUser = {
  id: string
  email: string
  name: string | null
  image: string | null
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
  const candidates = await db.user.findMany({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, email: true, name: true, image: true },
    take: 2,
  })
  // Historic PostgreSQL rows may differ only by case. Never let OAuth choose
  // one of multiple normalized identities, and never create a second account
  // beside an existing case-variant account.
  if (candidates.length > 1) return false
  let target: GoogleTargetUser
  if (candidates[0]) {
    target = candidates[0]
  } else {
    try {
      target = await db.user.create({
        data: { email, name, image, emailVerified: new Date() },
        select: { id: true, email: true, name: true, image: true },
      })
    } catch (error) {
      // A concurrent OAuth callback may win the normalized-email insert. Read
      // the single resulting identity instead of creating or selecting a
      // second account.
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002')) throw error
      const raced = await db.user.findMany({
        where: { email: { equals: email, mode: 'insensitive' } },
        select: { id: true, email: true, name: true, image: true },
        take: 2,
      })
      if (raced.length !== 1) return false
      target = raced[0]
    }
  }

  const targetGoogleAccount = await db.account.findFirst({
    where: { userId: target.id, provider: 'google' },
    select: { providerAccountId: true },
  })
  if (targetGoogleAccount && targetGoogleAccount.providerAccountId !== input.account.providerAccountId) {
    return false
  }

  // Auth.js has already built its session user from the legacy account row by
  // this point. Keep that object aligned with the verified Google user so the
  // session created by the same callback cannot retain the demo identity.
  input.user.id = target.id
  input.user.email = target.email
  input.user.name = target.name
  input.user.image = target.image

  const repaired = await db.account.updateMany({
    where: {
      provider: 'google',
      providerAccountId: input.account.providerAccountId,
    },
    data: { userId: target.id },
  })

  return repaired.count === 1
}
