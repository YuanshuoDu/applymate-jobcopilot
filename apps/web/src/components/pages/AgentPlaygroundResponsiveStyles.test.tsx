import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./AgentPlaygroundResponsiveStyles.tsx', import.meta.url), 'utf8')

describe('Agent playground responsive styles', () => {
  it('keeps the tablet split pane shrinkable and mobile chat on one scroll chain', () => {
    expect(source).toMatch(/@media \(max-width: 900px\)[\s\S]*\.agent-workspace-layout[\s\S]*flex-direction: column !important/)
    expect(source).toMatch(/\.agent-live-stream[\s\S]*height: 100% !important[\s\S]*overflow: hidden !important/)
    expect(source).toMatch(/\.agent-live-stream-body[\s\S]*overflow-y: auto !important/)
  })

  it('keeps the conversation drawer dismissible on mobile and inline on desktop', () => {
    expect(source).toMatch(/\.agent-session-drawer[\s\S]*transform: translateX\(-104%\)/)
    expect(source).toMatch(/\.agent-session-drawer\.is-open[\s\S]*transform: translateX\(0\)/)
    expect(source).toMatch(/@media \(min-width: 901px\)[\s\S]*\.agent-session-drawer[\s\S]*display: contents/)
  })
})
