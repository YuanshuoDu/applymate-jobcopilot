import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const migrationPath = fileURLToPath(new URL('../../prisma/migrations/20261027120000_restore_custom_agent_role/migration.sql', import.meta.url))
const migrationSql = readFileSync(migrationPath, 'utf8')

describe('CustomAgentRole restore migration', () => {
  it('creates the Prisma columns, defaults, user relation and index', () => {
    expect(migrationSql).toContain('CREATE TABLE public."CustomAgentRole"')
    expect(migrationSql).toContain('"id" TEXT NOT NULL,')
    expect(migrationSql).toContain('"userId" TEXT NOT NULL,')
    expect(migrationSql).toContain('"name" TEXT NOT NULL,')
    expect(migrationSql).toContain('"icon" TEXT NOT NULL DEFAULT \'🧩\'')
    expect(migrationSql).toContain('"description" TEXT,')
    expect(migrationSql).toContain('"systemPrompt" TEXT,')
    expect(migrationSql).toContain('"provider" TEXT NOT NULL DEFAULT \'anthropic\'')
    expect(migrationSql).toContain('"model" TEXT NOT NULL DEFAULT \'claude-haiku-4-5-20251001\'')
    expect(migrationSql).toContain('"insertAfter" TEXT NOT NULL DEFAULT \'auditor\'')
    expect(migrationSql).toContain('"enabled" BOOLEAN NOT NULL DEFAULT true')
    expect(migrationSql).toContain('"sortOrder" INTEGER NOT NULL DEFAULT 0')
    expect(migrationSql).toContain('"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP')
    expect(migrationSql).toContain('"updatedAt" TIMESTAMP(3) NOT NULL,')
    expect(migrationSql).toContain('FOREIGN KEY ("userId") REFERENCES public."User"("id")')
    expect(migrationSql).toContain('ON DELETE CASCADE ON UPDATE CASCADE')
    expect(migrationSql).toContain('CREATE INDEX "CustomAgentRole_userId_idx"')
    expect(migrationSql).toContain('USING btree ("userId")')
  })

  it('accepts only the exact existing column and default contract', () => {
    expect(migrationSql).toContain("<> 13")
    expect(migrationSql).toContain("('icon', 'text', true, '''🧩''::text')")
    expect(migrationSql).toContain("('provider', 'text', true, '''anthropic''::text')")
    expect(migrationSql).toContain("('model', 'text', true, '''claude-haiku-4-5-20251001''::text')")
    expect(migrationSql).toContain("('insertAfter', 'text', true, '''auditor''::text')")
    expect(migrationSql).toContain("('enabled', 'boolean', true, 'true')")
    expect(migrationSql).toContain("('sortOrder', 'integer', true, '0')")
    expect(migrationSql).toContain("('createdAt', 'timestamp(3) without time zone', true, 'current_timestamp')")
    expect(migrationSql).toContain("('id', 'text', true, NULL::pg_catalog.text)")
    expect(migrationSql).toContain("('updatedAt', 'timestamp(3) without time zone', true, NULL::pg_catalog.text)")
    expect(migrationSql).toContain('column_info.attgenerated IS DISTINCT FROM')
    expect(migrationSql).toContain('column_info.attidentity IS DISTINCT FROM')
    expect(migrationSql).toContain('pg_get_expr(column_default.adbin, column_default.adrelid)')
  })

  it('pins catalog resolution before any unqualified catalog access', () => {
    const pathSetup = "PERFORM pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true);"
    expect(migrationSql).toContain("pg_catalog.to_regclass('public.\"CustomAgentRole\"')")
    expect(migrationSql).toContain('role_table pg_catalog.regclass')
    expect(migrationSql.indexOf(pathSetup)).toBeGreaterThanOrEqual(0)
    expect(migrationSql.indexOf(pathSetup)).toBeLessThan(migrationSql.indexOf('IF user_table IS NULL'))
  })

  it('rejects incompatible keys and indexes without rewriting an existing table', () => {
    expect(migrationSql).toContain('conname = \'CustomAgentRole_pkey\'')
    expect(migrationSql).toContain('conname = \'CustomAgentRole_userId_fkey\'')
    expect(migrationSql).toContain("WHERE conrelid = role_table AND contype = 'f') <> 1")
    expect(migrationSql).toContain('confdeltype = \'c\' AND confupdtype = \'c\'')
    expect(migrationSql).toContain("index_relation.relname = 'CustomAgentRole_userId_idx'")
    expect(migrationSql).toContain("access_method.amname = 'btree'")
    expect(migrationSql).toContain("text_btree_opclass.opcname = 'text_ops'")
    expect(migrationSql).toContain('text_btree_opclass.opcdefault')
    expect(migrationSql).toContain('role_index.indclass::text = format(\'%s\', text_btree_opclass.oid)')
    expect(migrationSql).toContain("user_id_column.attcollation = to_regcollation('pg_catalog.default')")
    expect(migrationSql).toContain('role_index.indcollation::text = format(\'%s\', user_id_column.attcollation)')
    expect(migrationSql).toContain('CustomAgentRole existing schema is incompatible')
    expect(migrationSql).not.toMatch(/\b(DROP\s+TABLE|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE)\b/i)

    const existingBranch = migrationSql.split(/\bELSE\s+IF NOT EXISTS/)[1]
    expect(existingBranch).toBeDefined()
    expect(existingBranch).not.toMatch(/\b(CREATE\s+TABLE|CREATE\s+INDEX|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE|DELETE\s+FROM)\b/i)
  })
})
