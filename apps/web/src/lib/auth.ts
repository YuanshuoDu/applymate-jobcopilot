import NextAuth from 'next-auth'
import type { Provider } from 'next-auth/providers'
import { PrismaAdapter } from '@auth/prisma-adapter'
import Google from 'next-auth/providers/google'
import GitHub from 'next-auth/providers/github'
import Credentials from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { jwtVerify } from 'jose'
import { db } from '@/lib/db'

const JWT_SECRET = new TextEncoder().encode(
  process.env.AUTH_SECRET ?? 'fallback-secret-change-this',
)

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
  trustHost: true,
  session: { strategy: 'jwt' },
  callbacks: {
    async signIn({ user, account }) {
      // PrismaAdapter creates accounts on first sign-in but NEVER updates tokens on
      // subsequent sign-ins. updateMany patches the existing record so refresh_token
      // and access_token stay fresh. For new accounts (0 rows matched) this is a no-op
      // and PrismaAdapter's linkAccount will create the row normally.
      if (account?.provider === 'google' && account.access_token && user.id) {
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
          console.log('[auth] Google tokens refreshed, rows updated=', updated.count, 'scope=', account.scope)
        } catch (e) {
          console.error('[auth] Failed to update Google account tokens:', e)
        }
      }
      return true
    },
    async jwt({ token, user }) {
      if (user?.id) {
        token.id = user.id
      }

      if (token.id && !token.plan) {
        const dbUser = await db.user.findUnique({
          where: { id: token.id as string },
          select: { plan: true },
        })
        token.plan = dbUser?.plan
      }

      return token
    },
    async session({ session, token }) {
      if (session.user) {
        if (token?.id) session.user.id = token.id as string
        if (token?.plan) session.user.plan = token.plan as string
      }

      return session
    },
  },
  pages: {
    signIn: '/login',
    error:  '/login',
  },
})
