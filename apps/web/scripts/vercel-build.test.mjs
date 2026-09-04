import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { migrationEnvironment, shouldRecoverFailedGuestSupportMigration } = require('./vercel-build.cjs')

describe('Vercel build migration environment', () => {
  it('uses the direct database URL for Prisma migrations when configured', () => {
    const environment = {
      DATABASE_URL: 'postgresql://pooled.example/neondb',
      DIRECT_DATABASE_URL: 'postgresql://direct.example/neondb',
      VERCEL_ENV: 'production',
    }

    expect(migrationEnvironment(environment)).toEqual({
      ...environment,
      DATABASE_URL: environment.DIRECT_DATABASE_URL,
    })
    expect(environment.DATABASE_URL).toBe('postgresql://pooled.example/neondb')
  })

  it('converts a Neon pooled database URL to its direct endpoint', () => {
    const environment = {
      DATABASE_URL: 'postgresql://user:pass@ep-cool-sea-abb5rf5g-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require',
      DIRECT_DATABASE_URL: '  ',
    }

    expect(migrationEnvironment(environment)).toEqual({
      ...environment,
      DATABASE_URL: 'postgresql://user:pass@ep-cool-sea-abb5rf5g.eu-west-2.aws.neon.tech/neondb?sslmode=require',
    })
    expect(environment.DATABASE_URL).toContain('-pooler.')
  })

  it('keeps non-Neon URLs unchanged when no direct URL is configured', () => {
    const environment = { DATABASE_URL: 'postgresql://db.example/neondb', DIRECT_DATABASE_URL: '  ' }
    expect(migrationEnvironment(environment)).toBe(environment)
  })

  it('normalizes an explicitly configured pooled direct URL', () => {
    const environment = {
      DATABASE_URL: 'postgresql://pooled.example/neondb',
      DIRECT_DATABASE_URL: 'postgresql://user:pass@ep-cool-sea-abb5rf5g-pooler.eu-west-2.aws.neon.tech/neondb',
    }

    expect(migrationEnvironment(environment).DATABASE_URL).toBe('postgresql://user:pass@ep-cool-sea-abb5rf5g.eu-west-2.aws.neon.tech/neondb')
  })

  it('recovers only the known failed guest support migration', () => {
    expect(shouldRecoverFailedGuestSupportMigration('Error: P3018\nMigration name: 20260904170000_allow_guest_support_cases')).toBe(true)
    expect(shouldRecoverFailedGuestSupportMigration('Error: P3009\nThe 20260904170000_allow_guest_support_cases migration failed')).toBe(true)
    expect(shouldRecoverFailedGuestSupportMigration('Error: P3009\nThe other_migration migration failed')).toBe(false)
    expect(shouldRecoverFailedGuestSupportMigration('Migration name: 20260904170000_allow_guest_support_cases')).toBe(false)
  })
})
