import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./DashboardPage.css', import.meta.url), 'utf8')

describe('DashboardPage mobile layout', () => {
  it('constrains the primary column to the mobile content width', () => {
    expect(css).toMatch(/\.momentum-primary-column\s*\{[^}]*width:\s*100%/)
  })
})
