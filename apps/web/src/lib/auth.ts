import NextAuth from 'next-auth'
import type { Provider } from 'next-auth/providers'
import { PrismaAdapter } from '@auth/prisma-adapter'
import Google from 'next-auth/providers/google'
import GitHub from 'next-auth/providers/github'
import Credentials from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { jwtVerify } from 'jose'
import { db } from '@/lib/db'

const AUTH_SECRET = process.env.AUTH_SECRET ?? 'fallback-secret-change-this'
const JWT_SECRET = new TextEncoder().encode(AUTH_SECRET)

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
        const { payload } = await jwtVerify(credentials.token, JWT_SECRET)
        if (!payload.sub) return null
        const user = await db.user.findUnique({ where: { id: payload.sub as string } })
        if (!user) return null
        return { id: user.id, email: user.email, name: user.name, image: user.image }
      } catch {
        return null
      }
    }

    // ── Email+password auth ──
    if (!credentials?.email || !credentials?.password) return null
    const user = await db.user.findUnique({
      where: { email: credentials.email as string },
    })
    if (!user?.password) return null
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
    // Allows a Credentials (email/password) user to later link their Google account
    // with the same email — without this NextAuth throws OAuthAccountNotLinked.
    allowDangerousEmailAccountLinking: true,
    authorization: {
      params: {
        scope:       'openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
        access_type: 'offline',
        prompt:      'consent',
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
    async signIn({ user, account }) {
      // PrismaAdapter only INSERTS account rows via linkAccount on first OAuth;
      // it never updates them on subsequent sign-ins. Patch the existing row here so
      // a freshly issued access_token / refresh_token / scope replaces the stale data.
      // For first-time OAuth this is a no-op (0 rows) and linkAccount will handle it.
      if (account?.provider === 'google' && user.id) {
        console.log('[auth] signIn google for user', user.id, {
          hasAccess:  !!account.access_token,
          hasRefresh: !!account.refresh_token,
          expires_at: account.expires_at,
          scope:      account.scope,
        })
        if (account.access_token) {
          try {
            const updated = await db.account.updateMany({
              where: { userId: user.id, provider: 'google' },
              data: {
                access_token:  account.access_token,
                ...(account.refresh_token ? { refresh_token: account.refresh_token } : {}),
                ...(account.expires_at    ? { expires_at:    Number(account.expires_at) } : {}),
                ...(account.scope         ? { scope:         account.scope } : {}),
              },
            })
            console.log('[auth] Google tokens patched, rows updated=', updated.count)
          } catch (e) {
            console.error('[auth] Failed to update Google account tokens:', e)
          }
        }
      }
      return true
    },
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id
        // Cache plan in token to avoid per-request DB queries
        const dbUser = await db.user.findUnique({ where: { id: user.id }, select: { plan: true } })
        if (dbUser) token.plan = dbUser.plan
      }
      return token
    },
    async session({ session, token }) {
      if (token?.id && session.user) {
        session.user.id   = token.id as string
        session.user.plan = (token.plan as 'free' | 'pro' | 'enterprise') ?? 'free'
      }
      return session
    },
  },
  pages: {
    signIn: '/login',
    error:  '/login',
  },
})
