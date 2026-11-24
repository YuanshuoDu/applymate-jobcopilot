import type { PoolClient } from "pg"

type Queryable = Pick<PoolClient, "query">
export type OwnCorrectionSuccessorHeadScope = Readonly<{
  userId: string; sessionId: string; jobId: string; artifactId: string; priorVersion: number
  priorContentHash: string; sourceDigest: string; correctionWriterTaskId: string
}>

/** Locks and proves that the current draft head is the exact v+1 written by this correction task. */
export async function hasOwnCorrectionSuccessorHeadWithClient(
  client: Queryable, scope: OwnCorrectionSuccessorHeadScope,
): Promise<boolean> {
  if (![scope.userId, scope.sessionId, scope.jobId, scope.artifactId, scope.priorContentHash, scope.sourceDigest,
    scope.correctionWriterTaskId].every(value => typeof value === "string" && value.trim().length > 0)
    || !Number.isSafeInteger(scope.priorVersion) || scope.priorVersion < 1) return false
  const result = await client.query<Record<string, unknown>>(`SELECT artifact."id" AS "artifactId", artifact."version" AS "headVersion",
      artifact."hash" AS "headHash", version_row."version", version_row."contentHash", version_row."sourceDigest",
      version_row."previousHash", version_row."taskId"
    FROM "agent_artifact" AS artifact JOIN "agent_artifact_version" AS version_row
      ON version_row."artifactId" = artifact."id" AND version_row."version" = artifact."version"
      AND version_row."userId" = artifact."userId" AND version_row."jobId" = artifact."jobId"
      AND version_row."artifactType" = artifact."artifactType" AND version_row."contentHash" = artifact."hash"
    WHERE artifact."id"=$1 AND artifact."userId"=$2 AND artifact."jobId"=$3 AND artifact."artifactType"='cover_letter'
      AND artifact."lifecycle"='draft' AND artifact."version"=$5 + 1 AND artifact."previousHash"=$6
      AND version_row."sessionId"=$4 AND version_row."taskId"=$7 AND version_row."previousHash"=$6
      AND version_row."sourceDigest"=$8 LIMIT 2 FOR UPDATE OF artifact`,
  [scope.artifactId, scope.userId, scope.jobId, scope.sessionId, scope.priorVersion, scope.priorContentHash,
    scope.correctionWriterTaskId, scope.sourceDigest])
  const row = result.rows[0]
  return result.rows.length === 1 && row?.artifactId === scope.artifactId
    && Number(row.headVersion) === scope.priorVersion + 1 && Number(row.version) === scope.priorVersion + 1
    && row.contentHash === row.headHash && row.previousHash === scope.priorContentHash
    && row.sourceDigest === scope.sourceDigest && row.taskId === scope.correctionWriterTaskId
}
