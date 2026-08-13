import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./DashboardPage.css', import.meta.url), 'utf8')

describe('DashboardPage mobile layout', () => {
  it('constrains the primary column whenever the dashboard stacks', () => {
    expect(css).toMatch(/@media \(max-width: 900px\) \{[^\n]*\.momentum-primary-column \{ width: 100%/)
  })

  it('keeps the seven-day progress row inside a narrow dashboard column', () => {
    expect(css).toMatch(/\.momentum-days \{ display: grid; grid-template-columns: repeat\(7, minmax\(24px, 32px\)\); justify-content: start/)
    expect(css).toMatch(/\.momentum-days small \{ min-width: 0;[\s\S]*white-space: nowrap/)
  })

  it('wraps the weekly legend and adapts the card to its container width', () => {
    expect(css).toMatch(/\.momentum-goal-legend \{ flex-wrap: wrap/)
    expect(css).toMatch(/@container \(max-width: 680px\)/)
    expect(css).toMatch(/@container \(max-width: 510px\)/)
    expect(css).toMatch(/\.momentum-goal-legend \{ flex-wrap: wrap; justify-content: flex-start; gap: 8px 12px/)
  })
})
