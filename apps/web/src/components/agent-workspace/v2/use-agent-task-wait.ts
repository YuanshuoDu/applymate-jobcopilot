'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import type { AgentTaskWaitDto, AgentTaskWaitResponse } from '@/app/api/agent/sessions/[id]/tasks/[taskId]/waits/wait-projection'

const POLL_MS = 30_000
const REGISTRATION_RETRY_MS = 400
const TARGET_STATUSES = new Set(['queued', 'running', 'retrying', 'waiting', 'waiting_for_user', 'completed', 'failed', 'interrupted', 'cancelled', 'closed', 'passed', 'skipped', 'unknown'])

export type AgentTaskWaitPhase = 'checking' | 'empty' | 'available' | 'unavailable' | 'error'
type DeadlineKind = 'wait' | 'parent'
export type AgentTaskWaitState = Readonly<{ phase: AgentTaskWaitPhase; loading: boolean; wait: AgentTaskWaitDto | null; due: DeadlineKind | null }>
type RefreshReason = 'mount' | 'lifecycle' | 'focus' | 'visibility' | 'deadline' | 'poll' | 'registration' | 'manual'
type EventName = 'focus' | 'visibilitychange'
type Timer = ReturnType<typeof setTimeout>
export interface AgentTaskWaitEnvironment {
  readonly now?: () => number; readonly setTimeout?: (callback: () => void, delayMs: number) => Timer
  readonly clearTimeout?: (timer: Timer) => void; readonly isVisible?: () => boolean; readonly subscribe?: (event: EventName, callback: () => void) => () => void
}
type SchedulerOptions = { readonly sessionId: string; readonly parentTaskId: string; readonly lifecycleRevision: number; readonly onState: (state: AgentTaskWaitState) => void; readonly fetcher?: typeof fetch; readonly environment?: AgentTaskWaitEnvironment }

export function parseAgentTaskWaitResponse(value: unknown): AgentTaskWaitResponse | null {
  if (!isRecord(value) || !hasExactKeys(value, ['wait'])) return null
  if (value.wait === null) return { wait: null }
  const wait = value.wait
  if (!isRecord(wait) || !hasExactKeys(wait, ['mode', 'status', 'deadlineAt', 'parentDeadlineAt', 'targets'])
    || (wait.mode !== 'any' && wait.mode !== 'all') || wait.status !== 'waiting'
    || typeof wait.deadlineAt !== 'string' || !isIsoDate(wait.deadlineAt)
    || (wait.parentDeadlineAt !== null && (typeof wait.parentDeadlineAt !== 'string' || !isIsoDate(wait.parentDeadlineAt)))
    || !Array.isArray(wait.targets) || wait.targets.length === 0 || wait.targets.length > 8) return null
  const targets: AgentTaskWaitDto['targets'][number][] = []
  for (const target of wait.targets) {
    if (!isRecord(target) || !hasExactKeys(target, ['taskId', 'label', 'status', 'matched'])
      || !safeId(target.taskId) || (target.label !== null && (typeof target.label !== 'string' || target.label.length > 256))
      || typeof target.status !== 'string' || !TARGET_STATUSES.has(target.status) || typeof target.matched !== 'boolean') return null
    targets.push({ taskId: target.taskId, label: target.label as string | null, status: target.status as AgentTaskWaitDto['targets'][number]['status'], matched: target.matched })
  }
  if (new Set(targets.map(target => target.taskId)).size !== targets.length) return null
  return { wait: { mode: wait.mode, status: 'waiting', deadlineAt: wait.deadlineAt, parentDeadlineAt: wait.parentDeadlineAt as string | null, targets } }
}
export function createAgentTaskWaitRefreshController(options: SchedulerOptions) {
  const environment = options.environment ?? {}
  const now = environment.now ?? Date.now
  const setTimer = environment.setTimeout ?? ((callback, delay) => setTimeout(callback, delay))
  const clearTimer = environment.clearTimeout ?? (timer => clearTimeout(timer))
  const visibleNow = environment.isVisible ?? browserIsVisible
  const subscribe = environment.subscribe ?? browserSubscribe
  const fetcher = options.fetcher ?? fetch
  let state: AgentTaskWaitState = { phase: 'checking', loading: true, wait: null, due: null }
  let currentLifecycle = options.lifecycleRevision
  let visible = false; let started = false
  let stopped = false
  let generation = 0
  let lifecycleRefreshPending = false
  let request: { controller: AbortController; generation: number; reason: RefreshReason } | null = null
  let pendingReason: RefreshReason | null = null
  let pollTimer: Timer | null = null
  let retryTimer: Timer | null = null
  let deadlineTimer: Timer | null = null
  let immediateTimer: Timer | null = null
  let deadlineHandled: string | null = null
  let lastRegistrationRetryRevision: number | null = null
  const unsubscribe: Array<() => void> = []
  const url = `/api/agent/sessions/${encodeURIComponent(options.sessionId)}/tasks/${encodeURIComponent(options.parentTaskId)}/waits`
  const publish = (next: AgentTaskWaitState) => { state = next; options.onState(next) }
  const clear = (timer: Timer | null) => { if (timer !== null) clearTimer(timer) }
  const clearRefreshTimers = () => {
    clear(pollTimer); clear(retryTimer); clear(deadlineTimer); clear(immediateTimer)
    pollTimer = null; retryTimer = null; deadlineTimer = null; immediateTimer = null
  }
  const schedulePoll = () => {
    if (stopped || !visible || pollTimer !== null) return
    pollTimer = setTimer(() => { pollTimer = null; void refresh('poll') }, POLL_MS)
  }
  const markDeadlineDue = (kind: DeadlineKind, deadlineAt: string) => {
    const key = `${kind}:${deadlineAt}`
    if (stopped || deadlineHandled === key) return
    deadlineHandled = key
    publish({ ...state, due: kind })
    void refresh('deadline')
  }
  const scheduleDeadline = (wait: AgentTaskWaitDto) => {
    clear(deadlineTimer); deadlineTimer = null
  const next = earliestDeadline(wait)
    const dueAt = Date.parse(next.at)
    if (dueAt <= now()) { markDeadlineDue(next.kind, next.at); return }
    deadlineTimer = setTimer(() => { deadlineTimer = null; markDeadlineDue(next.kind, next.at) }, Math.min(dueAt - now(), 2_147_000_000))
  }
  const scheduleImmediate = (reason: RefreshReason) => {
    if (stopped || !visible || immediateTimer !== null) return
    immediateTimer = setTimer(() => { immediateTimer = null; void refresh(reason) }, 0)
  }
  const scheduleRegistrationRetry = (revision: number) => {
    if (lastRegistrationRetryRevision === revision || stopped || !visible) return
    lastRegistrationRetryRevision = revision
    clear(retryTimer)
    retryTimer = setTimer(() => { retryTimer = null; void refresh('registration') }, REGISTRATION_RETRY_MS)
  }

  async function refresh(reason: RefreshReason = 'manual'): Promise<void> {
    if (stopped || !started || !visible) return
    if (request) {
      if (reason !== 'poll') pendingReason = pendingReason === 'lifecycle' ? pendingReason : reason
      return
    }
    clear(pollTimer); pollTimer = null
    clear(immediateTimer); immediateTimer = null
    if (reason === 'lifecycle') { clear(retryTimer); retryTimer = null }
    const controller = new AbortController()
    const requestGeneration = generation
    const requestLifecycle = currentLifecycle
    request = { controller, generation: requestGeneration, reason }
    publish({ ...state, phase: state.wait ? 'available' : 'checking', loading: true })
    try {
      const response = await fetcher(url, {
        method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' }, signal: controller.signal,
      })
      const body = await response.json().catch(() => null) as unknown
      if (!response.ok) throw new Error('wait_projection_unavailable')
      if (stopped || requestGeneration !== generation || requestLifecycle !== currentLifecycle || controller.signal.aborted) return
      const parsed = parseAgentTaskWaitResponse(body)
      if (!parsed) {
        clear(retryTimer); retryTimer = null
        publish({ phase: 'unavailable', loading: false, wait: null, due: null })
      } else if (!parsed.wait) {
        clear(deadlineTimer); deadlineTimer = null
        publish({ phase: 'empty', loading: false, wait: null, due: null })
        if (reason === 'lifecycle' && requestLifecycle === currentLifecycle) scheduleRegistrationRetry(requestLifecycle)
      } else {
        clear(retryTimer); retryTimer = null
        const nextDeadline = earliestDeadline(parsed.wait)
        const due = Date.parse(nextDeadline.at) <= now() ? nextDeadline.kind : null
        publish({ phase: 'available', loading: false, wait: parsed.wait, due })
        scheduleDeadline(parsed.wait)
      }
    } catch (error) {
      if (!stopped && requestGeneration === generation && requestLifecycle === currentLifecycle && !(error instanceof DOMException && error.name === 'AbortError')) {
        clear(retryTimer); retryTimer = null
        publish({ phase: 'error', loading: false, wait: null, due: null })
      }
    } finally {
      if (request?.controller === controller) request = null
      if (stopped) return
      if (pendingReason && visible) {
        const nextReason = pendingReason
        pendingReason = null
        scheduleImmediate(nextReason)
      } else if (requestGeneration === generation && visible) schedulePoll()
    }
  }

  function setVisible(nextVisible: boolean): void {
    if (stopped || !started || visible === nextVisible) return
    visible = nextVisible
    if (!visible) {
      clearRefreshTimers(); pendingReason = null; generation += 1
      request?.controller.abort()
      publish({ ...state, loading: false })
    } else {
      const reason = lifecycleRefreshPending ? 'lifecycle' : 'visibility'
      lifecycleRefreshPending = false
      scheduleImmediate(reason)
    }
  }

  function updateLifecycle(revision: number): void {
    if (revision === currentLifecycle || stopped) return
    currentLifecycle = revision
    lifecycleRefreshPending = true
    if (visible) {
      lifecycleRefreshPending = false
      void refresh('lifecycle')
    }
  }
  function stop(): void {
    if (stopped) return
    stopped = true; generation += 1; pendingReason = null
    clearRefreshTimers()
    request?.controller.abort()
    unsubscribe.splice(0).forEach(remove => remove())
  }
  function start(): () => void {
    if (started) return stop
    started = true; visible = visibleNow()
    unsubscribe.push(subscribe('focus', () => {
      if (visibleNow()) {
        if (!visible) setVisible(true)
        else scheduleImmediate('focus')
      }
    }))
    unsubscribe.push(subscribe('visibilitychange', () => setVisible(visibleNow())))
    if (visible) void refresh('mount')
    else publish({ phase: 'empty', loading: false, wait: null, due: null })
    return stop
  }
  return { start, stop, refresh, updateLifecycle, setVisible, getSnapshot: () => state }
}

export function useAgentTaskWait(input: {
  readonly sessionId: string | null
  readonly parentTaskId: string | null
  readonly lifecycleRevision: number
  readonly enabled: boolean
  readonly fetcher?: typeof fetch
}) {
  const { sessionId, parentTaskId, lifecycleRevision, enabled, fetcher } = input
  const queryKey = enabled && sessionId && parentTaskId ? JSON.stringify([sessionId, parentTaskId]) : null
  const [stored, setStored] = useState<{ key: string | null; state: AgentTaskWaitState }>({ key: null, state: { phase: 'empty', loading: false, wait: null, due: null } })
  const controllerRef = useRef<ReturnType<typeof createAgentTaskWaitRefreshController> | null>(null)

  useEffect(() => {
    if (!queryKey || !sessionId || !parentTaskId) {
      controllerRef.current = null
      setStored({ key: null, state: { phase: 'empty', loading: false, wait: null, due: null } })
      return
    }
    let live = true
    const controller = createAgentTaskWaitRefreshController({ sessionId, parentTaskId, lifecycleRevision, onState: state => { if (live) setStored({ key: queryKey, state }) }, fetcher })
    controllerRef.current = controller
    const stop = controller.start()
    return () => {
      live = false; stop()
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [fetcher, parentTaskId, queryKey, sessionId])

  useEffect(() => { controllerRef.current?.updateLifecycle(lifecycleRevision) }, [lifecycleRevision])

  const refresh = useCallback(() => { void controllerRef.current?.refresh('manual') }, [])
  const state = stored.key === queryKey ? stored.state : { phase: queryKey ? 'checking' as const : 'empty' as const, loading: Boolean(queryKey), wait: null, due: null }
  return { ...state, refresh }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
function safeId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value }
function isIsoDate(value: string): boolean { return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) }
function earliestDeadline(wait: AgentTaskWaitDto): { kind: DeadlineKind; at: string } { return wait.parentDeadlineAt && Date.parse(wait.parentDeadlineAt) < Date.parse(wait.deadlineAt) ? { kind: 'parent', at: wait.parentDeadlineAt } : { kind: 'wait', at: wait.deadlineAt } }
function browserIsVisible(): boolean { return typeof document === 'undefined' || document.visibilityState !== 'hidden' }
function browserSubscribe(event: EventName, callback: () => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined
  const target: Window | Document = event === 'focus' ? window : document
  target.addEventListener(event, callback)
  return () => target.removeEventListener(event, callback)
}
