type UserMetadataRecord = {
  id: string
  name: string | null
  email: string
  plan: string
  location: string | null
  createdAt: Date
  _count?: { jobs: number; resumes: number; notifications: number }
  gmailSyncState?: { lastSyncedAt: Date | null; lastError: string | null } | null
}

function maskEmail(email: string) {
  const [local, domain = ''] = email.split('@')
  const localMask = local.length < 3 ? `${local[0] ?? ''}*` : `${local.slice(0, 2)}***`
  return `${localMask}@${domain}`
}

export function toAdminUserMetadata(user: UserMetadataRecord) {
  return {
    id: user.id,
    name: user.name,
    email: maskEmail(user.email),
    plan: user.plan,
    location: user.location,
    createdAt: user.createdAt,
    jobsCount: user._count?.jobs ?? 0,
    resumeExists: (user._count?.resumes ?? 0) > 0,
    notificationsCount: user._count?.notifications ?? 0,
    gmail: user.gmailSyncState ? { connected: true, lastSyncedAt: user.gmailSyncState.lastSyncedAt, hasError: Boolean(user.gmailSyncState.lastError) } : { connected: false, lastSyncedAt: null, hasError: false },
  }
}

export const adminUserMetadataSelect = {
  id: true,
  name: true,
  email: true,
  plan: true,
  location: true,
  createdAt: true,
  _count: { select: { jobs: true, resumes: true, notifications: true } },
  gmailSyncState: { select: { lastSyncedAt: true, lastError: true } },
} as const
