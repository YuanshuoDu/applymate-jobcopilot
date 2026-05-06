import NextAuth from 'next-auth'
import { PrismaAdapter } from '@auth/prisma-adapter'
import Google from 'next-auth/providers/google'
import GitHub from 'next-auth/providers/github'
import Credentials from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { db } from '@/lib/db'

// Build provider list dynamically — OAuth only enabled when keys are set
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const providers: any[] = []

// Credentials (email+password) — always available
providers.push(Credentials({
  name: 'Email & Password',
  credentials: {
    email:    { label: 'Email',    type: 'email' },
    password: { label: 'Password', type: 'password' },
  },
  async authorize(credentials) {
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
        scope:       'openid email profile https://www.googleapis.com/auth/gmail.readonly',
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
    async jwt({ token, user }) {
      if (user) token.id = user.id
      return token
    },
    async session({ session, token }) {
      if (token?.id && session.user) session.user.id = token.id as string
      return session
    },
  },
  pages: {
    signIn: '/login',
    error:  '/login',
  },
})
