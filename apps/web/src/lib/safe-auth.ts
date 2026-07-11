import { auth } from '@/lib/auth'
import { isRecoverableAuthSessionError } from '@/lib/safe-auth-errors'

export { isRecoverableAuthSessionError } from '@/lib/safe-auth-errors'

export async function safeAuth() {
  try {
    return await auth()
  } catch (error) {
    if (isRecoverableAuthSessionError(error)) return null
    throw error
  }
}
