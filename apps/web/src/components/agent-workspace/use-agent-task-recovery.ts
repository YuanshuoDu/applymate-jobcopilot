'use client'

import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import { AgentTaskRecoveryNotice } from './AgentTaskRecoveryNotice'
import { AgentComposerTaskAttemptStore } from './agent-composer-task-attempt-store'
import { AgentComposerTaskRecoveryController } from './agent-composer-task-recovery'
import type { AgentComposerTaskRecoveryNoticeState, AgentComposerTaskRecoverySnapshot } from './agent-composer-task-recovery-protocol'
import {
  consumeAcceptedComposerTaskAttempt,
  startRecoverableComposerTask,
  type RecoverableComposerTaskOutcome,
} from './agent-composer-task-recoverable-start'
import type { ComposerTaskTarget } from './agent-composer-task-availability'

type Options = Readonly<{
  selectedSessionId: string | null
  onOpenAccepted: (sessionId: string, turnId: string) => void | Promise<void>
  fetcher?: typeof fetch
  store?: AgentComposerTaskAttemptStore
}>

type RecoverySnapshotState = AgentComposerTaskRecoverySnapshot | Readonly<{ kind: 'loading' }>

export function canStartWithTaskRecoverySnapshot(snapshot: RecoverySnapshotState): boolean { return snapshot.kind === 'ready' }

export function taskRecoveryDisabledMessage(snapshot: RecoverySnapshotState): string | null {
  if (snapshot.kind === 'loading') return 'Checking task recovery. Wait before starting another task.'
  if (snapshot.kind === 'unavailable') return 'Task recovery is unavailable. Task start is disabled; your draft is preserved.'
  return null
}

type StartToken = Readonly<{ generation: number; selectedSessionId: string | null }>
type RefreshToken = StartToken & Readonly<{ request: number }>

export class AgentTaskRecoveryGenerationGate {
  private generation = 0
  private refreshRequest = 0
  private accountScope: string | null = null
  private selectedSessionId: string | null

  constructor(selectedSessionId: string | null) { this.selectedSessionId = selectedSessionId }
  select(sessionId: string | null): void {
    if (this.selectedSessionId !== sessionId) { this.selectedSessionId = sessionId; this.generation += 1 }
  }
  beginStart(): StartToken { return { generation: this.generation, selectedSessionId: this.selectedSessionId } }
  isStartCurrent(token: StartToken): boolean {
    return token.generation === this.generation && token.selectedSessionId === this.selectedSessionId
  }
  beginRefresh(): RefreshToken { return { ...this.beginStart(), request: ++this.refreshRequest } }
  completeRefresh(token: RefreshToken, accountScope: string | null): boolean {
    if (token.request !== this.refreshRequest || !this.isStartCurrent(token)) return false
    this.observeAccountScope(accountScope)
    return true
  }
  observeAccountScope(accountScope: string | null): boolean {
    if (!accountScope || !this.accountScope || this.accountScope === accountScope) {
      if (accountScope) this.accountScope = accountScope
      return false
    }
    this.accountScope = accountScope
    this.generation += 1
    return true
  }
  isSelectionCurrent(sessionId: string | null): boolean { return this.selectedSessionId === sessionId }
  dispose(): void { this.generation += 1; this.refreshRequest += 1 }
}

export function useAgentTaskRecovery(options: Options) {
  const fetcher = options.fetcher ?? fetch
  const storeRef = useRef(options.store ?? new AgentComposerTaskAttemptStore())
  const controllerRef = useRef<AgentComposerTaskRecoveryController | null>(null)
  if (!controllerRef.current) controllerRef.current = new AgentComposerTaskRecoveryController({ fetcher, store: storeRef.current })
  const controller = controllerRef.current
  const gateRef = useRef<AgentTaskRecoveryGenerationGate | null>(null)
  if (!gateRef.current) gateRef.current = new AgentTaskRecoveryGenerationGate(options.selectedSessionId)
  const gate = gateRef.current
  gate.select(options.selectedSessionId)
  const [snapshot, setSnapshot] = useState<RecoverySnapshotState>({ kind: 'loading' })
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const openAcceptedRef = useRef(options.onOpenAccepted)
  openAcceptedRef.current = options.onOpenAccepted

  const refresh = useCallback(async () => {
    const token = gate.beginRefresh()
    setSnapshot({ kind: 'loading' })
    const next = await controller.load()
    const scope = next.kind === 'ready' ? next.accountScope : null
    if (gate.completeRefresh(token, scope)) { snapshotRef.current = next; setSnapshot(next) }
    return next
  }, [controller, gate])

  useEffect(() => { void refresh() }, [options.selectedSessionId, refresh])
  useEffect(() => {
    const onFocus = () => { void refresh() }
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])
  useEffect(() => () => { gate.dispose(); controller.dispose() }, [controller, gate])

  const setNotice = useCallback((attemptKey: string, state: AgentComposerTaskRecoveryNoticeState) => {
    setSnapshot(previous => previous.kind === 'ready'
      ? { ...previous, attempts: previous.attempts.some(item => item.attemptKey === attemptKey)
        ? previous.attempts.map(item => item.attemptKey === attemptKey ? { ...item, state } : item)
        : [...previous.attempts, { attemptKey, state }] }
      : previous)
  }, [])
  const startTask = useCallback(async (objective: string, target: ComposerTaskTarget): Promise<RecoverableComposerTaskOutcome> => {
    const token = gate.beginStart()
    const expectedAccountScope = snapshotRef.current.kind === 'ready' ? snapshotRef.current.accountScope : ''
    if (!expectedAccountScope) return { kind: 'unavailable', state: { kind: 'unavailable', reason: 'error' } }
    const outcome = await startRecoverableComposerTask({
      target, objective, store: storeRef.current, controller, fetcher, expectedAccountScope,
      isCurrent: () => gate.isStartCurrent(token),
    })
    if (outcome.kind === 'stale') return outcome
    if ('snapshot' in outcome && outcome.snapshot) {
      const scope = outcome.snapshot.kind === 'ready' ? outcome.snapshot.accountScope : null
      const changed = gate.observeAccountScope(scope)
      if (changed && gate.isSelectionCurrent(token.selectedSessionId)) { snapshotRef.current = outcome.snapshot; setSnapshot(outcome.snapshot) }
      if (changed) return { kind: 'unavailable', state: { kind: 'unavailable', reason: 'error' }, snapshot: outcome.snapshot }
      if (!gate.isStartCurrent(token)) return { kind: 'stale' }
      snapshotRef.current = outcome.snapshot; setSnapshot(outcome.snapshot)
    }
    else if (outcome.kind === 'unavailable' && !outcome.attemptKey) setSnapshot({ kind: 'unavailable', reason: outcome.state.reason })
    else if ((outcome.kind === 'recovery' || outcome.kind === 'unavailable') && outcome.attemptKey) setNotice(outcome.attemptKey, outcome.state)
    else if (outcome.kind === 'accepted') {
      const next = await controller.load()
      const scope = next.kind === 'ready' ? next.accountScope : null
      const changed = gate.observeAccountScope(scope)
      if (changed) { snapshotRef.current = next; setSnapshot(next); return { kind: 'unavailable', state: { kind: 'unavailable', reason: 'error' }, snapshot: next } }
      if (!gate.isStartCurrent(token)) return { kind: 'stale' }
      snapshotRef.current = next; setSnapshot(next)
    }
    return outcome
  }, [controller, fetcher, gate, setNotice])

  const consumeAccepted = useCallback(async (outcome: Extract<RecoverableComposerTaskOutcome, { kind: 'accepted' }>) => {
    const removed = await consumeAcceptedComposerTaskAttempt({ store: storeRef.current, accountScope: outcome.accountScope,
      attemptKey: outcome.attemptKey, fetcher })
    if (removed) void refresh()
  }, [fetcher, refresh])

  const act = useCallback(async (key: string, action: 'check' | 'abandon' | 'open' | 'remove', sessionId?: string, turnId?: string) => {
    const token = gate.beginStart()
    const result = action === 'check' ? await controller.check(key)
      : action === 'abandon' ? await controller.abandon(key)
        : action === 'remove' ? await controller.removeRecoveryNotice(key)
          : await controller.openAccepted(key, async (id, turn) => {
            if (!gate.isStartCurrent(token) || id !== sessionId || turn !== turnId) throw new Error('Stale task recovery action')
            await openAcceptedRef.current(id, turn)
          })
    if (!gate.isStartCurrent(token)) return
    if (action === 'remove' || action === 'open') {
      if (result) void refresh()
    } else setNotice(key, result as AgentComposerTaskRecoveryNoticeState)
  }, [controller, gate, refresh, setNotice])

  const notices = snapshot.kind === 'ready'
    ? snapshot.attempts.map(item => createElement(AgentTaskRecoveryNotice, {
      key: item.attemptKey, state: item.state,
      onOpenAccepted: (sessionId: string, turnId: string) => act(item.attemptKey, 'open', sessionId, turnId),
      onCheck: () => act(item.attemptKey, 'check'),
      onAbandonAttempt: () => act(item.attemptKey, 'abandon'),
      onRemoveRecoveryNotice: () => act(item.attemptKey, 'remove'),
    }))
    : snapshot.kind === 'unavailable' ? [createElement(AgentTaskRecoveryNotice, {
      key: 'task-recovery-unavailable', state: { kind: 'unavailable', reason: snapshot.reason },
      onOpenAccepted: () => undefined, onCheck: async () => undefined, onAbandonAttempt: async () => undefined,
      onRemoveRecoveryNotice: () => undefined,
    })] : []

  return { snapshot, canStartTask: canStartWithTaskRecoverySnapshot(snapshot), disabledMessage: taskRecoveryDisabledMessage(snapshot), notices, refresh, startTask, consumeAccepted }
}
