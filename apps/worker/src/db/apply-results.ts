import pg from "pg";
import type { ApplicationSubmitIdentity } from "../queue/application-submit-fence.js";
import { withExactSubmissionWrite } from "./submission-guard.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString =
      process.env.DATABASE_URL ?? "postgresql://localhost:5432/applymate";
    pool = new Pool({ connectionString, max: 3 });
  }
  return pool;
}

/** Ensure apply_results table exists (called on worker startup) */
export async function ensureApplyResultsTable(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS apply_results (
        id          SERIAL PRIMARY KEY,
        user_id     TEXT NOT NULL,
        job_id      TEXT NOT NULL,
        mode        TEXT NOT NULL DEFAULT 'unattended',
        ats_type    TEXT,
        flow_used   TEXT,
        status      TEXT NOT NULL,
        error       TEXT,
        duration_ms INT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } finally {
    client.release();
  }
}

export interface InsertApplyResult {
  userId: string;
  jobId: string;
  mode?: string;
  atsType?: string | null;
  flowUsed?: string | null;
  status: string;
  error?: string | null;
  durationMs?: number | null;
  /** Present for every canonical submit result; omitted for fill-only outcomes. */
  submissionIdentity?: ApplicationSubmitIdentity;
}

/** Insert a row into apply_results */
export async function insertApplyResult(
  result: InsertApplyResult
): Promise<number | null> {
  if (result.flowUsed === "application.submit" && !result.submissionIdentity) {
    throw new Error("Canonical submit results require an exact application attempt identity.");
  }
  const pool = getPool();
  if (result.submissionIdentity) {
    const fenced = await withExactSubmissionWrite(pool, result.submissionIdentity, "insert_apply_result", client =>
      insertApplyResultWithClient(client, result));
    return fenced.kind === "current" ? fenced.value : null;
  }
  const client = await pool.connect();
  try {
    return await insertApplyResultWithClient(client, result);
  } finally {
    client.release();
  }
}

async function insertApplyResultWithClient(
  client: Pick<pg.PoolClient, "query">,
  result: InsertApplyResult,
): Promise<number> {
    const res = await client.query(
      `INSERT INTO apply_results (user_id, job_id, mode, ats_type, flow_used, status, error, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        result.userId,
        result.jobId,
        result.mode ?? "unattended",
        result.atsType ?? null,
        result.flowUsed ?? null,
        result.status,
        result.error ?? null,
        result.durationMs ?? null,
      ]
    );
    return res.rows[0].id;
}

/** Close the pool (for tests) */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
