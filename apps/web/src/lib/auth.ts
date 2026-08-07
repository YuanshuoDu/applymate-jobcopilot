import NextAuth from 'next-auth'
import type { Provider } from 'next-auth/providers'
import { PrismaAdapter } from '@auth/prisma-adapter'
import Google from 'next-auth/providers/google'
import GitHub from 'next-auth/providers/github'
import Credentials from 'next-auth/providers/credentials'
import { db } from '@/lib/db'
import { reconcileGoogleLoginIdentity } from '@/lib/google-identity'
import { getAuthSecret } from '@/lib/auth-secret'
import { canonicalAuthRedirect } from '@/lib/auth-url'
import { encryptAccountTokenFields } from '@/lib/credential-secrets'
import { assertNoAuthOriginOverride } from '@/lib/auth-runtime-config'
import { authorizeCredentials } from '@/lib/credential-authorizer'
import {
  refreshEmailOnlySessionToken,
  refreshExistingSessionToken,
  sessionTokenEmail,
  sessionTokenUserId,
} from '@/lib/auth-session-token'
import { authVersionFromClaim } from '@/lib/auth-version'
import { shouldSuppressAuthSessionErrorLog } from '@/lib/safe-auth-errors'

assertNoAuthOriginOverride()
const AUTH_SECRET = getAuthSecret()

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
  async authorize(credentials, request) {
    return authorizeCredentials(credentials, request)
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
  logger: {
    error(error) {
      if (shouldSuppressAuthSessionErrorLog(error, process.env.NODE_ENV)) return
      console.error(error)
    },
  },
  callbacks: {
    async signIn({ user, account, profile }) {
      if (account?.provider === 'google') {
        const validIdentity = await reconcileGoogleLoginIdentity({ user, account, profile })
        if (!validIdentity) return '/login?error=OAuthIdentityMismatch'
      }

      // OAuth providers can resolve a previously linked account without using
      // Credentials.authorize. Enforce the same lifecycle rule before a JWT is
      // minted, including after Google identity reconciliation changes user.id.
      if (!user.id) return '/login?error=AccountUnavailable'
      const currentUser = await db.user.findUnique({
        where: { id: user.id },
        select: { accountStatus: true },
      })
      if (!currentUser || currentUser.accountStatus !== 'active') return '/login?error=AccountUnavailable'

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
      if (!user) {
        const userId = sessionTokenUserId(token)
        if (userId) {
          const current = await db.user.findUnique({
            where: { id: userId },
            select: { plan: true, authVersion: true, accountStatus: true },
          })
          return refreshExistingSessionToken(token, current)
        }

        const email = sessionTokenEmail(token)
        const candidates = email
          ? await db.user.findMany({
            where: { email: { equals: email, mode: 'insensitive' } },
            select: { id: true, plan: true, authVersion: true, accountStatus: true },
            take: 2,
          })
          : []
        return refreshEmailOnlySessionToken(token, candidates.length === 1 ? candidates[0] : null)
      }
      return token
    },
    async session({ session, token }) {
      const userId = sessionTokenUserId(token)
      if (!userId || !session.user) {
        // Return the public DefaultSession shape so a malformed or revoked JWT
        // cannot keep the client in an authenticated-looking application shell.
        return { expires: session.expires }
      }

      session.user.id   = userId
      session.user.plan = (token.plan as 'free' | 'pro' | 'enterprise') ?? 'free'
      session.user.authVersion = authVersionFromClaim(token.authVersion)
      session.user.adminSessionVersion = typeof token.adminSessionVersion === 'number' ? token.adminSessionVersion : undefined
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
