import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./AgentPage.tsx', import.meta.url), 'utf8')

describe('orphaned AgentPage settings surface', () => {
  it('does not retain the obsolete Scout plus no-session SSE run entry point', () => {
    expect(source).not.toContain('AgentRunPanel')
    expect(source).not.toContain('/api/agent/scout')
    expect(source).not.toContain("new EventSource('/api/agent/run')")
    expect(source).not.toContain('showRunPanel')
  })
})
