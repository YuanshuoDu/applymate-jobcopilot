import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const schema = readFileSync(resolve(__dirname, 'schema.prisma'), 'utf8')

describe('admin users and plans Prisma schema', () => {
  it('declares account state and the versioned plan catalogue controls', () => {
    expect(schema).toContain('enum UserAccountStatus {')
    expect(schema).toContain('model PlanCatalogue {')
    expect(schema).toContain('entitlements Json')
    expect(schema).toContain('model PlanTransition {')
    expect(schema).toContain('model UserPlanChange {')
    expect(schema).toContain('model UserFeatureOverride {')
    const userBlock = schema.match(/model User \{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(userBlock).toContain('accountStatus')
  })
})
