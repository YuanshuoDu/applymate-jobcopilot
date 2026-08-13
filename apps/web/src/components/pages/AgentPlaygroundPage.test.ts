import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./AgentPlaygroundPage.tsx', import.meta.url), 'utf8')
const streamSource = readFileSync(new URL('../agent-workspace/AgentUnifiedStream.tsx', import.meta.url), 'utf8')
const appShellSource = readFileSync(new URL('../layout/AppShell.tsx', import.meta.url), 'utf8')

describe('Agent workspace responsive layout', () => {
  it('stacks the workspace before the tablet split pane can overflow', () => {
    expect(source).toMatch(/@media \(max-width: 900px\)[\s\S]*\.agent-workspace-layout/)
  })

  it('keeps mobile Agent content on one scroll chain above the fixed navigation', () => {
    expect(source).toMatch(/\.agent-workspace-layout[\s\S]*overflow: hidden !important/)
    expect(source).toMatch(/\.agent-live-stream[\s\S]*height: 100% !important[\s\S]*overflow: hidden !important/)
    expect(source).toMatch(/\.agent-live-stream-body[\s\S]*overflow-y: auto !important/)
  })

  it('keeps every desktop split-pane flex boundary shrinkable from first paint', () => {
    expect(appShellSource).toMatch(/id="main-content" style=\{\{ flex: 1, minWidth: 0, minHeight: 0/)
    expect(source).toMatch(/minWidth: 0, minHeight: 0, display: 'flex'[\s\S]*agent-workspace-layout/)
    expect(source).toMatch(/agent-workspace-layout" style=\{\{ flex: 1, minWidth: 0, minHeight: 0/)
    expect(streamSource).toMatch(/agent-live-stream" style=\{\{ flex: 1, minWidth: 0, minHeight: 0/)
  })

  it('hides sessions in a dismissible mobile drawer so chat stays primary', () => {
    expect(source).toContain('agent-session-drawer')
    expect(source).toMatch(/\.agent-session-drawer[\s\S]*transform: translateX\(-104%\)/)
    expect(source).toContain('aria-controls="agent-session-drawer"')
    expect(source).toContain('Close conversations')
    expect(source).toContain('Back to Home')
    expect(source).toContain('agent-session-drawer-home')
    expect(source).toContain("navigate('dashboard')")
    expect(source).toContain('Collapse conversations')
    expect(source).toContain('agent-session-drawer-collapse')
  })

  it('restores the last opened session and records future session views server-side', () => {
    expect(source).toContain('initialSessionRestoredRef')
    expect(source).toContain('lastOpenedSessionId')
    expect(source).toContain("method: 'PATCH'")
    expect(source).toContain('onSessionsLoaded={restoreLastSession}')
  })
})
