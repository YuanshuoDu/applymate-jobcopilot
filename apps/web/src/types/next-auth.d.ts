import type { DefaultSession } from 'next-auth'
import type { DefaultJWT } from 'next-auth/jwt'

declare module 'next-auth' {
  interface Session {
    user: DefaultSession['user'] & {
      id:   string
      plan: 'free' | 'pro' | 'enterprise'
      adminSessionVersion?: number
    }
  }
}

declare module 'next-auth/jwt' {
  interface JWT extends DefaultJWT {
    id?: string
    plan?: string
    adminSessionVersion?: number
  }
}
