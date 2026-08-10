import { db } from '@/lib/db'
import { allowsUsageAnalytics } from '@/lib/privacy-consent'
import { safeAuth } from '@/lib/safe-auth'

/**
 * Resolve analytics consent on the server before the analytics client mounts.
 * Missing sessions, missing users, and failed lookups deliberately fail closed.
 */
export async function getUsageAnalyticsConsent(): Promise<boolean> {
  try {
    const session = await safeAuth()
    const userId = session?.user?.id
    if (!userId) return false

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { preferences: true },
    })
    if (!user) return false

    return allowsUsageAnalytics(user.preferences)
  } catch {
    return false
  }
}
