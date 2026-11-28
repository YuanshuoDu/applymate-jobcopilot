import type { PoolClient } from "pg"
import {
  buildAgentSourceMaterialFenceKey,
  normalizeAgentSourceMaterialFenceError,
  sortUniqueAgentSourceMaterialFenceUserIds,
} from "@jobcopilot/shared"

const TRANSACTION_CHECK_ERROR = "source material fence transaction verification failed"
const LOCK_SQL = `
  SELECT pg_current_xact_id()::text AS transaction_id,
         pg_advisory_xact_lock(hashtextextended($1::text, 0)) AS lock_acquired
`
const VERIFY_TRANSACTION_SQL = "SELECT pg_current_xact_id()::text AS transaction_id"

type TransactionIdRow = Record<string, unknown> & { transaction_id: unknown }

function isTransactionId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]+$/.test(value)
}

/** Acquires the shared source-material fence using the caller's open transaction. */
export async function acquireSourceMaterialFence(
  client: PoolClient,
  userIds: readonly string[],
): Promise<void> {
  const sortedUserIds = sortUniqueAgentSourceMaterialFenceUserIds(userIds)
  if (sortedUserIds.length === 0) {
    throw new TypeError("source material fence requires at least one user ID")
  }

  let expectedTransactionId: string | undefined
  try {
    for (const userId of sortedUserIds) {
      const key = buildAgentSourceMaterialFenceKey(userId)
      const result = await client.query<TransactionIdRow>(LOCK_SQL, [key])
      const transactionId = result.rows[0]?.transaction_id
      if (!isTransactionId(transactionId) || (expectedTransactionId !== undefined && transactionId !== expectedTransactionId)) {
        throw new Error(TRANSACTION_CHECK_ERROR)
      }
      expectedTransactionId ??= transactionId
    }

    const verification = await client.query<TransactionIdRow>(VERIFY_TRANSACTION_SQL)
    const verifiedTransactionId = verification.rows[0]?.transaction_id
    if (!isTransactionId(verifiedTransactionId) || verifiedTransactionId !== expectedTransactionId) {
      throw new Error(TRANSACTION_CHECK_ERROR)
    }
  } catch (error) {
    throw normalizeAgentSourceMaterialFenceError(error)
  }
}
