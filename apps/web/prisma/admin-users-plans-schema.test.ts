import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const schema = readFileSync(resolve(__dirname, 'schema.prisma'), 'utf8')

describe('admin users and plans Prisma schema', () => {
  it('declares account state and the complete plan catalogue models', () => {
    expect(schema).toContain('enum UserAccountStatus {')
    expect(schema).toContain('enum PlanEntitlementKind {')
    expect(schema).toContain('model PlanCatalog {')
    expect(schema).toContain('model PlanEntitlement {')
    expect(schema).toContain('model PlanTransition {')
    expect(schema).toContain('model UserPlanChange {')
    expect(schema).toContain('model UserFeatureOverride {')
    const userBlock = schema.match(/model User \{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(userBlock).toContain('accountStatus')
  })
})
