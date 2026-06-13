import { randomUUID } from "node:crypto";
import { getPool } from "./apply-results.js";

export interface FormPatternRow {
  id: string;
  atsHost: string;
  urlPattern: string;
  fieldMapping: Record<string, string>;
  successCount: number;
  failureCount: number;
  lastSuccessAt: string;
}

function normalizeFieldMapping(value: unknown): Record<string, string> {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, string>;
    } catch {
      return value as unknown as Record<string, string>;
    }
  }
  return (value ?? {}) as Record<string, string>;
}

/**
 * Upsert a form pattern. On conflict (same atsHost + urlPattern),
 * increments successCount, resets failureCount, and updates mapping.
 */
export async function upsertFormPattern(params: {
  atsHost: string;
  urlPattern: string;
  fieldMapping: Record<string, string>;
}): Promise<void> {
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO form_patterns (
       id, ats_host, url_pattern, field_mapping, success_count, failure_count,
       last_success_at, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, 1, 0, NOW(), NOW(), NOW())
     ON CONFLICT (ats_host, url_pattern) DO UPDATE
     SET field_mapping   = EXCLUDED.field_mapping,
         success_count   = form_patterns.success_count + 1,
         failure_count   = 0,
         last_success_at = NOW(),
         updated_at      = NOW()`,
    [id, params.atsHost, params.urlPattern, JSON.stringify(params.fieldMapping)]
  );
}

/**
 * Find a form pattern by ATS host and URL pattern.
 * Returns null if no match is found.
 */
export async function findFormPattern(
  atsHost: string,
  urlPattern: string
): Promise<FormPatternRow | null> {
  const result = await getPool().query(
    `SELECT id, ats_host, url_pattern, field_mapping, success_count, failure_count, last_success_at
     FROM form_patterns
     WHERE ats_host = $1 AND url_pattern = $2
     LIMIT 1`,
    [atsHost, urlPattern]
  );
  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    id: row.id,
    atsHost: row.ats_host,
    urlPattern: row.url_pattern,
    fieldMapping: normalizeFieldMapping(row.field_mapping),
    successCount: row.success_count,
    failureCount: row.failure_count,
    lastSuccessAt: row.last_success_at,
  };
}

/** Record a failed replay attempt by incrementing failureCount. */
export async function recordPatternFailure(formPatternId: string): Promise<void> {
  await getPool().query(
    `UPDATE form_patterns
     SET failure_count = failure_count + 1,
         updated_at = NOW()
     WHERE id = $1`,
    [formPatternId]
  );
}
