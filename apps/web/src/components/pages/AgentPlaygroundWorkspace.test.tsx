import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./AgentPlaygroundWorkspace.tsx', import.meta.url), 'utf8')

describe('Agent playground workspace shell', () => {
  it('retains accessible mobile session drawer controls', () => {
    expect(source).toContain('aria-controls="agent-session-drawer"')
    expect(source).toContain("t('agent.closeConversations')")
    expect(source).toContain("t('agent.backHome')")
    expect(source).toContain("t('agent.collapseConversations')")
    expect(source).toContain("navigate('dashboard')")
  })

  it('keeps session console and page content inside the same workspace layout', () => {
    expect(source).toContain('<AgentSessionConsole {...sessionProps} />')
    expect(source).toContain('{children}')
    expect(source).toMatch(/agent-workspace-layout" style=\{\{ flex: 1, minWidth: 0, minHeight: 0/)
  })
})
