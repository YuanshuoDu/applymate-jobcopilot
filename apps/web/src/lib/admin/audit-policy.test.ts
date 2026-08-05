import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('audit database policy', () => {
  it('ships an append-only trigger and revokes public mutation privileges', () => {
    const migration = readFileSync(resolve(process.cwd(), 'prisma/migrations/20260805132000_lock_admin_audit_log/migration.sql'), 'utf8')
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "AdminAuditLog"')
    expect(migration).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON "AdminAuditLog" FROM PUBLIC')
  })
})
