import NextAuth from 'next-auth'
import type { Provider } from 'next-auth/providers'
import { PrismaAdapter } from '@auth/prisma-adapter'
import Google from 'next-auth/providers/google'
import GitHub from 'next-auth/providers/github'
import Credentials from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { jwtVerify } from 'jose'
import { db } from '@/lib/db'
import { normalizeEmail } from '@/lib/auth-identifiers'
import { reconcileGoogleLoginIdentity } from '@/lib/google-identity'
import { EXTENSION_TOKEN_AUDIENCE, EXTENSION_TOKEN_ISSUER, getAuthJwtSecret, getAuthSecret } from '@/lib/auth-secret'
import { canonicalAuthRedirect } from '@/lib/auth-url'
import { encryptAccountTokenFields } from '@/lib/credential-secrets'
import { isCurrentAuthVersion } from '@/lib/auth-version'

const AUTH_SECRET = getAuthSecret()
const JWT_SECRET = getAuthJwtSecret()

// Build provider list dynamically — OAuth only enabled when keys are set
const providers: Provider[] = []

// Credentials: email+password OR extension JWT token
providers.push(Credentials({
  name: 'Email & Password',
  credentials: {
    email:    { label: 'Email',    type: 'email' },
    password: { label: 'Password', type: 'password' },
    token:    { label: 'Token',    type: 'text' },     // Extension JWT sync
  },
  async authorize(credentials) {
    // ── Extension JWT auth (token sync) ──
    if (credentials?.token && typeof credentials.token === 'string') {
      try {
        const { payload } = await jwtVerify(credentials.token, JWT_SECRET, {
          issuer: EXTENSION_TOKEN_ISSUER,
          audience: EXTENSION_TOKEN_AUDIENCE,
        })
        if (typeof payload.sub !== 'string' || !payload.sub) return null
        const user = await db.user.findUnique({
          where: { id: payload.sub as string },
          select: { id: true, email: true, name: true, image: true, accountStatus: true, authVersion: true },
        })
        if (!user || user.accountStatus !== 'active' || !isCurrentAuthVersion(payload.authVersion, user.authVersion)) return null
        return { id: user.id, email: user.email, name: user.name, image: user.image }
      } catch {
        return null
      }
    }

    // ── Email+password auth ──
    if (!credentials?.email || !credentials?.password) return null
    const email = normalizeEmail(credentials.email as string)
    if (!email) return null
    const user = await db.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
    })
    if (!user?.password || user.accountStatus !== 'active') return null
    const valid = await bcrypt.compare(credentials.password as string, user.password)
    if (!valid) return null
    return { id: user.id, email: user.email, name: user.name, image: user.image }
  },
}))

// Google OAuth — only if configured
if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
  providers.push(Google({
    clientId:     process.env.AUTH_GOOGLE_ID,
    clientSecret: process.env.AUTH_GOOGLE_SECRET,
    // Credentials users may choose Google later. The signIn callback above
    // rejects an unverified Google email before Auth.js can link by email.
    allowDangerousEmailAccountLinking: true,
    // Gmail access is deliberately requested by the separate Gmail integration
    // flow. A sign-in must only establish the ApplyMate identity.
    authorization: {
      params: {
        scope:  'openid email profile',
        prompt: 'select_account',
      },
    },
  }))
}

// GitHub OAuth — only if configured
if (process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET) {
  providers.push(GitHub({
    clientId:     process.env.AUTH_GITHUB_ID,
    clientSecret: process.env.AUTH_GITHUB_SECRET,
  }))
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: PrismaAdapter(db),
  providers,
  secret: AUTH_SECRET,
  trustHost: true,
  session: { strategy: 'jwt' },
  callbacks: {
    async signIn({ user, account, profile }) {
      if (account?.provider === 'google') {
        const validIdentity = await reconcileGoogleLoginIdentity({ user, account, profile })
        if (!validIdentity) return '/login?error=OAuthIdentityMismatch'
      }

      // OAuth providers can resolve a previously linked account without using
      // Credentials.authorize. Enforce the same lifecycle rule before a JWT is
      // minted, including after Google identity reconciliation changes user.id.
      if (user.id) {
        const currentUser = await db.user.findUnique({
          where: { id: user.id },
          select: { accountStatus: true },
        })
        if (currentUser && currentUser.accountStatus !== 'active') return '/login?error=AccountUnavailable'
      }

      // PrismaAdapter only INSERTS account rows via linkAccount on first OAuth;
      // it never updates them on subsequent sign-ins. Patch the existing row here so
      // a freshly issued access_token / refresh_token / scope replaces the stale data.
      // For first-time OAuth this is a no-op (0 rows) and linkAccount will handle it.
      if (account?.provider === 'google' && account.providerAccountId) {
        console.log('[auth] signIn google account', {
          hasAccess:  !!account.access_token,
          hasRefresh: !!account.refresh_token,
          expires_at: account.expires_at,
          scope:      account.scope,
        })
        if (account.access_token) {
          try {
            const encryptedTokens = await encryptAccountTokenFields({
              provider: 'google',
              providerAccountId: account.providerAccountId,
              accessToken: account.access_token,
              refreshToken: account.refresh_token ?? null,
              idToken: account.id_token ?? null,
            })
            const updated = await db.account.updateMany({
              where: { provider: 'google', providerAccountId: account.providerAccountId },
              data: {
                access_token: null,
                accessTokenEnc: encryptedTokens.accessTokenEnc,
                ...(account.refresh_token ? { refresh_token: null, refreshTokenEnc: encryptedTokens.refreshTokenEnc } : {}),
                ...(account.id_token ? { id_token: null, idTokenEnc: encryptedTokens.idTokenEnc } : {}),
                ...(account.expires_at    ? { expires_at:    Number(account.expires_at) } : {}),
                ...(account.scope         ? { scope:         account.scope } : {}),
              },
            })
            console.log('[auth] Google tokens patched, rows updated=', updated.count)
          } catch (e) {
            await db.account.updateMany({
              where: { provider: 'google', providerAccountId: account.providerAccountId },
              data: { access_token: null, refresh_token: null, id_token: null },
            }).catch(() => undefined)
            console.error('[auth] Failed to protect Google account tokens:', e)
            return '/login?error=CredentialProtectionUnavailable'
          }
        }
      }
      return true
    },
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id
        // Cache plan and revocation versions at sign-in. The general version
        // invalidates every session after password/account-state changes without
        // logging users out after ordinary profile or preference updates.
        const [dbUser, membership] = await Promise.all([
          db.user.findUnique({ where: { id: user.id }, select: { plan: true, authVersion: true } }),
          db.adminMembership.findUnique({ where: { userId: user.id }, select: { sessionVersion: true } }),
        ])
        if (dbUser) token.plan = dbUser.plan
        if (dbUser) token.authVersion = dbUser.authVersion
        token.adminSessionVersion = membership?.sessionVersion
      }
      if (!user && typeof token.id === 'string') {
        const current = await db.user.findUnique({ where: { id: token.id }, select: { authVersion: true, accountStatus: true } })
        if (!current || current.accountStatus !== 'active' || !isCurrentAuthVersion(token.authVersion, current.authVersion)) return {}
        token.authVersion = current.authVersion
      }
      return token
    },
    async session({ session, token }) {
      if (token?.id && session.user) {
        session.user.id   = token.id as string
        session.user.plan = (token.plan as 'free' | 'pro' | 'enterprise') ?? 'free'
        session.user.adminSessionVersion = typeof token.adminSessionVersion === 'number' ? token.adminSessionVersion : undefined
      }
      return session
    },
    async redirect({ url, baseUrl }) {
      return canonicalAuthRedirect(
        url,
        baseUrl,
        process.env.AUTH_CANONICAL_URL ?? 'https://applymate.site',
        process.env.VERCEL_ENV === 'preview',
      )
    },
  },
  events: {
    // PrismaAdapter creates first-time OAuth accounts after signIn. Encrypt
    // the adapter-created token row as a final write boundary as well.
    async linkAccount({ account }) {
      if (!account.providerAccountId || !account.access_token) return
      if (account.provider !== 'google' && account.provider !== 'github') return
      try {
        const encryptedTokens = await encryptAccountTokenFields({
          provider: account.provider,
          providerAccountId: account.providerAccountId,
          accessToken: account.access_token,
          refreshToken: account.refresh_token ?? null,
          idToken: account.id_token ?? null,
        })
        await db.account.updateMany({
          where: { provider: account.provider, providerAccountId: account.providerAccountId },
          data: encryptedTokens,
        })
      } catch (error) {
        await db.account.updateMany({
          where: { provider: account.provider, providerAccountId: account.providerAccountId },
          data: { access_token: null, refresh_token: null, id_token: null },
        }).catch(() => undefined)
        throw error
      }
    },
  },
  pages: {
    signIn: '/login',
    error:  '/login',
  },
})
