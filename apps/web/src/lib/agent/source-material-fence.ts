import type { Prisma } from '@prisma/client'
import {
  buildAgentSourceMaterialFenceKey,
  normalizeAgentSourceMaterialFenceError,
  sortUniqueAgentSourceMaterialFenceUserIds,
} from '@jobcopilot/shared'

const INVALID_FENCE_TRANSACTION = 'source material fence transaction verification failed'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readTransactionId(result: unknown): string | null {
  if (!Array.isArray(result) || result.length !== 1) return null

  const row: unknown = result[0]
  if (!isRecord(row)) return null

  const transactionId = row.transaction_id
  return typeof transactionId === 'string' && /^[1-9]\d*$/.test(transactionId)
    ? transactionId
    : null
}

/**
 * Takes the shared source-material fence for each user in deterministic order.
 * The caller must keep this transaction open through all protected work and commit.
 */
export async function acquireSourceMaterialFence(
  tx: Prisma.TransactionClient,
  userIds: readonly string[],
): Promise<void> {
  const sortedUserIds = sortUniqueAgentSourceMaterialFenceUserIds(userIds)
  if (sortedUserIds.length === 0) {
    throw new TypeError('source material fence requires at least one user ID')
  }
  const keys = sortedUserIds.map(buildAgentSourceMaterialFenceKey)

  try {
    const lockResults: unknown[] = []
    for (const key of keys) {
      lockResults.push(await tx.$queryRaw<unknown[]>`
        SELECT pg_current_xact_id()::text AS transaction_id,
          pg_advisory_xact_lock(hashtextextended(${key}::text, 0))::text AS lock_acquired
      `)
    }

    const verificationResult = await tx.$queryRaw<unknown[]>`
      SELECT pg_current_xact_id()::text AS transaction_id
    `
    const verificationId = readTransactionId(verificationResult)
    const lockTransactionIds = lockResults.map(readTransactionId)

    if (
      verificationId === null ||
      lockTransactionIds.some(transactionId => transactionId === null || transactionId !== verificationId)
    ) {
      throw new Error(INVALID_FENCE_TRANSACTION)
    }
  } catch (error) {
    throw normalizeAgentSourceMaterialFenceError(error)
  }
}
