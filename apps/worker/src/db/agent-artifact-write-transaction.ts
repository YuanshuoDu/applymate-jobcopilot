import type { Pool, PoolClient } from "pg"
import { withArtifactTransaction } from "./agent-artifact-repo-helpers.js"
import { acquireSourceMaterialFence } from "./source-material-fence.js"

/** Acquires the source and artifact locks before running a source-sensitive write. */
export async function withFencedArtifactWriteTransaction<T>(
  pool: Pool,
  userId: string,
  jobId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withArtifactTransaction(pool, userId, async client => {
    await acquireSourceMaterialFence(client, [userId])
    await acquireArtifactJobAdvisoryLock(client, userId, jobId)
    return work(client)
  })
}

async function acquireArtifactJobAdvisoryLock(client: PoolClient, userId: string, jobId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [userId, jobId])
}
