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
})
