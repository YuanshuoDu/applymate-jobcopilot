import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AgentTaskRecoveryGenerationGate, canStartWithTaskRecoverySnapshot, taskRecoveryDisabledMessage } from './use-agent-task-recovery'

const source = readFileSync(new URL('./use-agent-task-recovery.ts', import.meta.url), 'utf8')

describe('useAgentTaskRecovery', () => {
  it('fails closed until authenticated IndexedDB recovery has loaded', () => {
    expect(canStartWithTaskRecoverySnapshot({ kind: 'loading' })).toBe(false)
    expect(canStartWithTaskRecoverySnapshot({ kind: 'unavailable', reason: 'storage' })).toBe(false)
    expect(canStartWithTaskRecoverySnapshot({ kind: 'unavailable', reason: 'error' })).toBe(false)
    expect(canStartWithTaskRecoverySnapshot({ kind: 'ready', accountScope: 'scope', attempts: [] })).toBe(true)
  })

  it('distinguishes recovery loading from unavailable storage or network state', () => {
    expect(taskRecoveryDisabledMessage({ kind: 'loading' })).toMatch(/Checking task recovery/)
    for (const reason of ['storage', 'error'] as const) {
      const message = taskRecoveryDisabledMessage({ kind: 'unavailable', reason })
      expect(message).toMatch(/recovery is unavailable/i)
      expect(message).toMatch(/draft is preserved/i)
      expect(message).not.toMatch(/checking task recovery/i)
    }
    expect(taskRecoveryDisabledMessage({ kind: 'ready', accountScope: 'scope', attempts: [] })).toBeNull()
  })

  it('reloads only the recovery controller on mount, selection changes, focus, and visible state', () => {
    expect(source).toContain('const next = await controller.load()')
    expect(source).toContain("window.addEventListener('focus', onFocus)")
    expect(source).toContain("document.addEventListener('visibilitychange', onVisible)")
    expect(source).toContain("document.visibilityState === 'visible'")
    const refreshStart = source.indexOf('const refresh = useCallback')
    const refreshEnd = source.indexOf('useEffect(() => { void refresh()', refreshStart)
    expect(source.slice(refreshStart, refreshEnd)).not.toContain('startRecoverableComposerTask')
    expect(source.slice(refreshStart, refreshEnd)).not.toContain('start-objective')
  })

  it('keeps receipt opens and notice actions bound to one attempt key and selected-session generation', () => {
    expect(source).toContain('const token = gate.beginStart()')
    expect(source).toContain('controller.openAccepted(key')
    expect(source).toContain('controller.abandon(key)')
    expect(source).toContain('controller.removeRecoveryNotice(key)')
    expect(source).toContain('if (!gate.isStartCurrent(token) || id !== sessionId || turn !== turnId)')
  })

  it('allows a pending start to survive a deferred focus refresh but invalidates on identity changes', async () => {
    const gate = new AgentTaskRecoveryGenerationGate(null)
    gate.observeAccountScope('scope-a')
    const start = gate.beginStart()
    let finishStart!: () => void
    const pendingStart = new Promise<void>(resolve => { finishStart = resolve })
    const focusRefresh = gate.beginRefresh()
    gate.completeRefresh(focusRefresh, 'scope-a')
    finishStart()
    await pendingStart
    expect(gate.isStartCurrent(start)).toBe(true)

    gate.select('session-b')
    expect(gate.isStartCurrent(start)).toBe(false)
    const nextStart = gate.beginStart()
    expect(gate.isStartCurrent(nextStart)).toBe(true)
    gate.observeAccountScope('scope-b')
    expect(gate.isStartCurrent(nextStart)).toBe(false)
  })
})
