import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./AgentPlaygroundPage.tsx', import.meta.url), 'utf8')

describe('Agent workspace responsive layout', () => {
  it('stacks the workspace before the tablet split pane can overflow', () => {
    expect(source).toMatch(/@media \(max-width: 900px\)[\s\S]*\.agent-workspace-layout/)
  })

  it('keeps mobile Agent content on one scroll chain above the fixed navigation', () => {
    expect(source).toMatch(/\.agent-workspace-layout[\s\S]*overflow: hidden !important/)
    expect(source).toMatch(/\.agent-live-stream[\s\S]*height: 100% !important[\s\S]*overflow: hidden !important/)
    expect(source).toMatch(/\.agent-live-stream-body[\s\S]*overflow-y: auto !important/)
  })

  it('hides sessions in a dismissible mobile drawer so chat stays primary', () => {
    expect(source).toContain('agent-session-drawer')
    expect(source).toMatch(/\.agent-session-drawer[\s\S]*transform: translateX\(-104%\)/)
    expect(source).toContain('aria-controls="agent-session-drawer"')
    expect(source).toContain('Close conversations')
    expect(source).toContain('Back to Home')
    expect(source).toContain('agent-session-drawer-home')
    expect(source).toContain("navigate('dashboard')")
  })

  it('restores the last opened session and records future session views server-side', () => {
    expect(source).toContain('initialSessionRestoredRef')
    expect(source).toContain('lastOpenedSessionId')
    expect(source).toContain("method: 'PATCH'")
    expect(source).toContain('onSessionsLoaded={restoreLastSession}')
  })
})
