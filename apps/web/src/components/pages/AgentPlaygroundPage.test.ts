import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./AgentPlaygroundPage.tsx', import.meta.url), 'utf8')

describe('Agent workspace responsive layout', () => {
  it('stacks the workspace before the tablet split pane can overflow', () => {
    expect(source).toMatch(/@media \(max-width: 900px\)[\s\S]*\.agent-workspace-layout/)
  })
})
