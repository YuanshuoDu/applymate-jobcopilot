import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isDurableTurnRunning } from './AgentPlaygroundPage'

const source = readFileSync(new URL('./AgentPlaygroundPage.tsx', import.meta.url), 'utf8')
const streamSource = readFileSync(new URL('../agent-workspace/AgentUnifiedStream.tsx', import.meta.url), 'utf8')
const appShellSource = readFileSync(new URL('../layout/AppShell.tsx', import.meta.url), 'utf8')
const automationSource = readFileSync(new URL('../agent-workspace/AutomationList.tsx', import.meta.url), 'utf8')
const workspaceSource = readFileSync(new URL('./AgentPlaygroundWorkspace.tsx', import.meta.url), 'utf8')
const responsiveStylesSource = readFileSync(new URL('./AgentPlaygroundResponsiveStyles.tsx', import.meta.url), 'utf8')
const runSource = readFileSync(new URL('./useAgentPlaygroundRun.ts', import.meta.url), 'utf8')
const composerSource = readFileSync(new URL('../agent-workspace/AgentUnifiedStreamComposer.tsx', import.meta.url), 'utf8')

describe('Agent workspace responsive layout', () => {
  it('stacks the workspace before the tablet split pane can overflow', () => {
    expect(responsiveStylesSource).toMatch(/@media \(max-width: 900px\)[\s\S]*\.agent-workspace-layout/)
  })

  it('keeps mobile Agent content on one scroll chain above the fixed navigation', () => {
    expect(responsiveStylesSource).toMatch(/\.agent-workspace-layout[\s\S]*overflow: hidden !important/)
    expect(responsiveStylesSource).toMatch(/\.agent-live-stream[\s\S]*height: 100% !important[\s\S]*overflow: hidden !important/)
    expect(responsiveStylesSource).toMatch(/\.agent-live-stream-body[\s\S]*overflow-y: auto !important/)
  })

  it('keeps every desktop split-pane flex boundary shrinkable from first paint', () => {
    expect(appShellSource).toMatch(/id="main-content" style=\{\{ flex: 1, minWidth: 0, minHeight: 0/)
    expect(workspaceSource).toMatch(/minWidth: 0, minHeight: 0, display: 'flex'[\s\S]*agent-workspace-layout/)
    expect(workspaceSource).toMatch(/agent-workspace-layout" style=\{\{ flex: 1, minWidth: 0, minHeight: 0/)
    expect(streamSource).toMatch(/agent-live-stream" style=\{\{ flex: 1, minWidth: 0, minHeight: 0/)
  })

  it('hides sessions in a dismissible mobile drawer so chat stays primary', () => {
    expect(workspaceSource).toContain('agent-session-drawer')
    expect(responsiveStylesSource).toMatch(/\.agent-session-drawer[\s\S]*transform: translateX\(-104%\)/)
    expect(workspaceSource).toContain('aria-controls="agent-session-drawer"')
    expect(workspaceSource).toContain("t('agent.closeConversations')")
    expect(workspaceSource).toContain("t('agent.backHome')")
    expect(workspaceSource).toContain('agent-session-drawer-home')
    expect(workspaceSource).toContain("navigate('dashboard')")
    expect(workspaceSource).toContain("t('agent.collapseConversations')")
    expect(workspaceSource).toContain('agent-session-drawer-collapse')
  })

  it('restores the last opened session and records future session views server-side', () => {
    expect(source).toContain('initialSessionRestoredRef')
    expect(source).toContain('lastOpenedSessionId')
    expect(source).toContain("method: 'PATCH'")
    expect(source).toContain('onSessionsLoaded: restoreLastSession')
  })

  it('uses the URL session as the single page identity and provides the active Turn composer', () => {
    expect(source).toContain('useAgentSessionUrl')
    expect(source).toContain('useAgentSessionState(sessionId)')
    expect(source).toContain('<AgentTurnComposerProvider value={turnComposer}>')
    expect(source).toContain('resumeSessionId={sessionId}')
    expect(source).not.toContain('liveSessionId')
  })

  it('keeps canonical active Turn controls and running status in sync with lifecycle events', () => {
    expect(source).toMatch(/if \(!selectedSessionId \|\| timeline\.lifecycleRevision === 0\) return/)
    expect(source).toMatch(/refetchTurnState\(\)\n\s*\}, \[refetchTurnState, selectedSessionId, timeline\.lifecycleRevision\]\)/)
    expect(source).toMatch(/function isDurableTurnRunning\(status: ActiveTurnStatus \| undefined\): boolean \{\n\s*return status === 'queued' \|\| status === 'in_progress'/)
    expect(source).toContain('const isRunning = isDurableTurnRunning(activeTurn?.status) ||')
    expect(source).toContain('(runLog.length > 0 && !runDone)')
    expect(source).not.toContain("status === 'waiting_for_approval' ||")
    expect(source).not.toContain("status === 'waiting_for_user' ||")
    expect(source).not.toContain("status === 'waiting_for_dependency' ||")
  })

  it('marks only queued and in-progress durable Turns as running', () => {
    expect(isDurableTurnRunning('queued')).toBe(true)
    expect(isDurableTurnRunning('in_progress')).toBe(true)
    expect(isDurableTurnRunning('waiting_for_dependency')).toBe(false)
    expect(isDurableTurnRunning('waiting_for_approval')).toBe(false)
    expect(isDurableTurnRunning('waiting_for_user')).toBe(false)
    expect(isDurableTurnRunning(undefined)).toBe(false)
  })

  it('keeps one execution stream and delegates session rendering to the V2 timeline client', () => {
    const retiredChatStreamModule = ['agent', 'chat', 'stream'].join('-')
    expect(runSource.match(/new EventSource\(/g) ?? []).toHaveLength(1)
    expect(source).toContain('useAgentTimeline')
    expect(source).toContain('<AgentSupervisorPanel')
    expect(streamSource).not.toContain('streamAgentTimeline')
    expect(composerSource).toContain('sendAgentTurnMessage')
    expect(composerSource).toContain("fetch('/api/agent/sessions'")
    expect(composerSource).not.toContain('/api/agent/chat')
    expect(composerSource).not.toContain('streamAgentChat')
    expect(streamSource).not.toContain(retiredChatStreamModule)
  })

  it('does not stop an active Turn from page cleanup', () => {
    expect(source).not.toContain('beforeunload')
  })
})

describe('canonical automation runs', () => {
  it('selects the already-enqueued session without opening the legacy SSE run', () => {
    const onRunSessionBody = source.match(/onRunSession: \(id, policy\) => \{([\s\S]*?)\n\s*\},/)?.[1]

    expect(onRunSessionBody).toBeTruthy()
    expect(onRunSessionBody).toContain('selectAutomationSession(id, policy)')
    expect(onRunSessionBody).not.toContain('startRun(')
    expect(source).toContain('setActiveRunPolicy(policy)')
  })

  it('hands the canonical run response session to the page after refresh', () => {
    expect(automationSource).toContain("/api/agent/automations/${row.id}/run")
    expect(automationSource).toContain("window.dispatchEvent(new Event('applymate:sessions-changed'))")
    expect(automationSource).toContain('onSessionStarted?.(sessionId, row)')
  })
})
