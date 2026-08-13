import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./AgentPlaygroundPage.tsx', import.meta.url), 'utf8')

describe('Agent workspace responsive layout', () => {
  it('stacks the workspace before the tablet split pane can overflow', () => {
    expect(source).toMatch(/@media \(max-width: 900px\)[\s\S]*\.agent-workspace-layout/)
  })

  it('keeps mobile Agent content on one scroll chain above the fixed navigation', () => {
    expect(source).toMatch(/\.agent-workspace-layout[\s\S]*overscroll-behavior-y: auto/)
    expect(source).toMatch(/\.agent-live-stream[\s\S]*overflow: visible !important/)
    expect(source).toMatch(/\.agent-live-stream-body\[data-empty='true'\][\s\S]*overflow: visible !important[\s\S]*padding-bottom: 24px !important/)
  })
})
