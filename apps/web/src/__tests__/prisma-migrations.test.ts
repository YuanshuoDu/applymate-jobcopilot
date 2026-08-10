import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const migrationsRoot = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url))

describe('Prisma migration dependencies', () => {
  it('creates ai_budgets before a later migration alters or references it', () => {
    const migrations = readdirSync(migrationsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .map((name) => ({ name, sql: readFileSync(join(migrationsRoot, name, 'migration.sql'), 'utf8') }))

    const createIndex = migrations.findIndex(({ sql }) => /CREATE TABLE(?: IF NOT EXISTS)? "ai_budgets"/.test(sql))
    const dependentIndex = migrations.findIndex(({ sql }) => /(?:ALTER TABLE|REFERENCES) "ai_budgets"/.test(sql))

    expect(createIndex).toBeGreaterThanOrEqual(0)
    expect(dependentIndex).toBeGreaterThan(createIndex)
  })

  it('backfills the audit hash chain before enforcing record hashes', () => {
    const migrationPath = join(migrationsRoot, '20260810013000_backfill_admin_audit_hash_chain', 'migration.sql')
    const migration = readFileSync(migrationPath, 'utf8')

    expect(migration).toContain('DISABLE TRIGGER "admin_audit_log_append_only"')
    expect(migration).toContain('ORDER BY "createdAt" ASC, "id" ASC')
    expect(migration).toContain('SET "previous_hash" = previous, "record_hash" = current_hash')
    expect(migration).toContain('ENABLE TRIGGER "admin_audit_log_append_only"')
    expect(migration).toContain('ALTER COLUMN "record_hash" SET NOT NULL')
  })
})
