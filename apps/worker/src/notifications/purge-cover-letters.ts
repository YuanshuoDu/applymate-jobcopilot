import type pg from 'pg'
import { getPool } from '../db/apply-results.js'

function retainsGeneratedCoverLetters(preferences: unknown): boolean {
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) return true
  const privacy = (preferences as Record<string, unknown>).privacyPreferences
  if (!privacy || typeof privacy !== 'object' || Array.isArray(privacy)) return true
  return (privacy as Record<string, unknown>).storeCoverLetters !== false
}

/** Remove temporary AI letters after a confirmed worker submission. */
export async function purgeTemporaryGeneratedCoverLetters(
  userId: string,
  jobId: string,
  pool: pg.Pool = getPool(),
): Promise<number> {
  const lookup = await pool.query<{ preferences: unknown; finalCoverLetterId: string | null }>(
    `SELECT u.preferences, j."finalCoverLetterId"
       FROM "User" u
       JOIN "Job" j ON j."userId" = u.id
      WHERE u.id = $1 AND j.id = $2
      LIMIT 1`,
    [userId, jobId],
  )
  // A failed/legacy pool mock may return no result object. Treat that as a
  // no-op; retention cleanup must never make an application result fail.
  const row = lookup?.rows?.[0]
  if (!row || retainsGeneratedCoverLetters(row.preferences)) return 0

  const deleted = await pool.query(
    `DELETE FROM "CoverLetter"
      WHERE "userId" = $1
        AND "jobId" = $2
        AND origin IN ('agent', 'ai-generated')
        AND "isFinal" = FALSE
        AND ($3::text IS NULL OR id <> $3)`,
    [userId, jobId, row.finalCoverLetterId],
  )
  return deleted.rowCount ?? 0
}
