import type { Pool, PoolClient } from "pg"

export type AgentArtifactLifecycle = "base" | "draft"

export type AgentArtifactRow = {
  readonly id: string
  readonly userId: string
  readonly jobId: string
  readonly artifactType: string
  readonly lifecycle: AgentArtifactLifecycle
  readonly baseId: string | null
  readonly baseHash: string | null
  readonly content: unknown
  readonly hash: string
  readonly constraintHash: string
  readonly provenanceRefs: string[]
  readonly evidenceRefs: string[]
  readonly previousHash: string | null
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type AgentArtifactBaseInsert = {
  readonly id: string
  readonly userId: string
  readonly jobId: string
  readonly artifactType: string
  readonly content: unknown
  readonly hash: string
  readonly constraintHash: string
  readonly provenanceRefs: readonly string[]
  readonly evidenceRefs: readonly string[]
}

export type AgentArtifactDraftWrite = AgentArtifactBaseInsert & {
  readonly baseId: string
  readonly baseHash: string
  readonly previousHash: string | null
  readonly expectedPreviousHash?: string | null
}

export class AgentArtifactRepositoryError extends Error {
  constructor(readonly code: "not_found" | "stale_hash" | "invalid_provenance" | "precondition_failed", message: string) {
    super(message)
    this.name = "AgentArtifactRepositoryError"
  }
}

const columns = `"id", "userId", "jobId", "artifactType", "lifecycle", "baseId", "baseHash", "content", "hash", "constraintHash", "provenanceRefs", "evidenceRefs", "previousHash", "version", "createdAt", "updatedAt"`

function toRow(row: Record<string, unknown>): AgentArtifactRow {
  const stringArray = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
  const lifecycle = row.lifecycle === "base" || row.lifecycle === "draft" ? row.lifecycle : null
  if (!lifecycle || typeof row.id !== "string" || typeof row.userId !== "string" || typeof row.jobId !== "string" || typeof row.artifactType !== "string" || typeof row.hash !== "string" || typeof row.constraintHash !== "string") {
    throw new AgentArtifactRepositoryError("precondition_failed", "The database returned an invalid artifact record.")
  }
  return {
    id: row.id,
    userId: row.userId,
    jobId: row.jobId,
    artifactType: row.artifactType,
    lifecycle,
    baseId: typeof row.baseId === "string" ? row.baseId : null,
    baseHash: typeof row.baseHash === "string" ? row.baseHash : null,
    content: row.content,
    hash: row.hash,
    constraintHash: row.constraintHash,
    provenanceRefs: stringArray(row.provenanceRefs),
    evidenceRefs: stringArray(row.evidenceRefs),
    previousHash: typeof row.previousHash === "string" ? row.previousHash : null,
    version: typeof row.version === "number" ? row.version : Number(row.version),
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(String(row.createdAt)),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt : new Date(String(row.updatedAt)),
  }
}

async function selectOne(client: Pick<Pool, "query">, userId: string, artifactId: string, lock = false): Promise<AgentArtifactRow | null> {
  const result = await client.query<Record<string, unknown>>(`SELECT ${columns} FROM "agent_artifact" WHERE "id" = $1 AND "userId" = $2${lock ? " FOR UPDATE" : ""}`, [artifactId, userId])
  return result.rows[0] ? toRow(result.rows[0]) : null
}

async function withTransaction<T>(pool: Pool, userId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", userId])
    const value = await work(client)
    await client.query("COMMIT")
    return value
  } catch (error: unknown) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export function createAgentArtifactRepository(pool: Pool) {
  return {
    async find(userId: string, artifactId: string): Promise<AgentArtifactRow | null> {
      if (!userId.trim() || !artifactId.trim()) return null
      return selectOne(pool, userId, artifactId)
    },

    async insertBase(input: AgentArtifactBaseInsert): Promise<AgentArtifactRow> {
      const result = await pool.query<Record<string, unknown>>(
        `INSERT INTO "agent_artifact" (${columns}) VALUES ($1, $2, $3, $4, 'base', $1, $5, $6::jsonb, $7, $8, $9, $9, NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING ${columns}`,
        [input.id, input.userId, input.jobId, input.artifactType, input.hash, JSON.stringify(input.content), input.hash, input.constraintHash, [...input.provenanceRefs]],
      )
      return toRow(result.rows[0] ?? {})
    },

    async saveDraft(input: AgentArtifactDraftWrite): Promise<AgentArtifactRow> {
      return withTransaction(pool, input.userId, async client => {
        const base = await selectOne(client, input.userId, input.baseId, true)
        if (!base) throw new AgentArtifactRepositoryError("not_found", "Artifact is not available in the current tenant.")
        if (base.lifecycle !== "base" || base.hash !== input.baseHash || base.artifactType !== input.artifactType) {
          throw new AgentArtifactRepositoryError("stale_hash", "Draft base hash is stale or unavailable.")
        }
        if (input.evidenceRefs.length === 0) throw new AgentArtifactRepositoryError("invalid_provenance", "Draft requires evidence.")

        const previous = await selectOne(client, input.userId, input.id, true)
        if (previous?.lifecycle === "base") throw new AgentArtifactRepositoryError("precondition_failed", "A base artifact cannot be replaced by a draft.")
        if (previous && (previous.jobId !== base.jobId || previous.baseId !== input.baseId || previous.artifactType !== input.artifactType)) {
          throw new AgentArtifactRepositoryError("precondition_failed", "Draft identity does not match its base artifact.")
        }
        if (previous && input.expectedPreviousHash !== undefined && input.expectedPreviousHash !== previous.hash) {
          throw new AgentArtifactRepositoryError("precondition_failed", "Draft update has a stale previous hash.")
        }
        const previousHash = previous?.hash ?? input.previousHash
        if (previous) {
          const result = await client.query<Record<string, unknown>>(
            `UPDATE "agent_artifact" SET "content" = $1::jsonb, "hash" = $2, "constraintHash" = $3, "provenanceRefs" = $4, "evidenceRefs" = $4, "previousHash" = $5, "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $6 AND "userId" = $7 AND "lifecycle" = 'draft' RETURNING ${columns}`,
            [JSON.stringify(input.content), input.hash, input.constraintHash, [...input.provenanceRefs], previousHash, input.id, input.userId],
          )
          return toRow(result.rows[0] ?? {})
        }
        const result = await client.query<Record<string, unknown>>(
          `INSERT INTO "agent_artifact" (${columns}) VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7::jsonb, $8, $9, $10, $10, $11, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING ${columns}`,
          [input.id, input.userId, base.jobId, input.artifactType, input.baseId, input.baseHash, JSON.stringify(input.content), input.hash, input.constraintHash, [...input.provenanceRefs], previousHash],
        )
        return toRow(result.rows[0] ?? {})
      })
    },

    async list(userId: string, jobId: string): Promise<AgentArtifactRow[]> {
      const result = await pool.query<Record<string, unknown>>(`SELECT ${columns} FROM "agent_artifact" WHERE "userId" = $1 AND "jobId" = $2 ORDER BY "updatedAt" DESC, "id" ASC`, [userId, jobId])
      return result.rows.map(toRow)
    },
  }
}
