import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./DashboardPage.css', import.meta.url), 'utf8')

describe('DashboardPage mobile layout', () => {
  it('constrains the primary column whenever the dashboard stacks', () => {
    expect(css).toMatch(/@media \(max-width: 900px\) \{[^\n]*\.momentum-primary-column \{ width: 100%/)
  })
})
