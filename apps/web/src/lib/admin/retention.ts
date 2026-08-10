import { db } from '@/lib/db'

export const RETENTION_POLICY_KEY = 'completed_deletion_requests' as const
export const DEFAULT_RETENTION_DAYS = 90

export async function getDeletionRetentionPolicy() {
  const policy = await db.dataRetentionPolicy.findUnique({ where: { key: RETENTION_POLICY_KEY } })
  return policy ?? {
    id: null,
    key: RETENTION_POLICY_KEY,
    name: 'Completed deletion queue records',
    retentionDays: DEFAULT_RETENTION_DAYS,
    enabled: true,
    version: 1,
    updatedById: null,
    createdAt: null,
    updatedAt: null,
  }
}

export async function purgeRetainedDeletionRecords(now = new Date()) {
  const policy = await getDeletionRetentionPolicy()
  if (!policy.enabled) return { policy: policy.key, deleted: 0, skipped: true }
  const cutoff = new Date(now.getTime() - policy.retentionDays * 24 * 60 * 60_000)
  const result = await db.adminDataDeletionRequest.deleteMany({
    where: {
      status: { in: ['completed', 'cancelled'] },
      updatedAt: { lt: cutoff },
    },
  })
  return { policy: policy.key, deleted: result.count, skipped: false, cutoff }
}
