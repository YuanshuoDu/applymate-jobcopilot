import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const schema = readFileSync(resolve(__dirname, 'schema.prisma'), 'utf8')

describe('admin security Prisma schema', () => {
  it('declares the isolated membership, role, audit, and idempotency models', () => {
    expect(schema).toContain('model AdminRole {')
    expect(schema).toContain('model AdminMembership {')
    expect(schema).toContain('model AdminAuditLog {')
    expect(schema).toContain('model AdminIdempotencyKey {')
  })

  it('does not add a boolean admin flag to User', () => {
    const userBlock = schema.match(/model User \{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(userBlock).not.toMatch(/isAdmin\s+Boolean/)
  })
})
