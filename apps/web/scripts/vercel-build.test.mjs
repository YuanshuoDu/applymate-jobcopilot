import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { migrationEnvironment } = require('./vercel-build.cjs')

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

  it('keeps the normal database URL when no direct URL is configured', () => {
    const environment = { DATABASE_URL: 'postgresql://pooled.example/neondb', DIRECT_DATABASE_URL: '  ' }
    expect(migrationEnvironment(environment)).toBe(environment)
  })
})
