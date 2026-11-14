'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { parseApplicationTasks, type ApplicationTaskView } from './application-task-model'

const EMPTY_TASKS: ApplicationTaskView[] = []
const useCommitEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect
type ParsedTasks = { tasks: ApplicationTaskView[]; limited: boolean }
type CommittedScope = { owner: string | null; epoch: number }
type Snapshot = { owner: string | null; epoch: number; loading: boolean; error: boolean; parsed: ParsedTasks | null }

/** Scope and epoch both match only after the relevant account was committed. */
export function isCurrentApplicationTaskSnapshot(scope: CommittedScope, snapshot: Pick<Snapshot, 'owner' | 'epoch'>, owner: string | null): boolean {
  return owner !== null && scope.owner === owner && snapshot.owner === owner && snapshot.epoch === scope.epoch
}

/** Reject late responses even if a fetch implementation ignores cancellation. */
export function createApplicationTaskRequestGate() {
  let generation = 0
  let controller: AbortController | null = null
  return {
    start() {
      controller?.abort()
      const current = ++generation
      const next = new AbortController()
      controller = next
      return { signal: next.signal, current: () => generation === current }
    },
    cancel() { ++generation; controller?.abort(); controller = null },
  }
}

/** One bounded GET per page, shared by its rows and drawer. No per-job fetch or write. */
export function useApplicationTasks({ enabled = true }: { enabled?: boolean } = {}) {
  const { data: session, status } = useSession()
  const userId = status === 'authenticated' ? session?.user?.id ?? null : null
  const active = enabled && Boolean(userId)
  const scope = active ? userId : null
  const scopeRef = useRef<CommittedScope>({ owner: null, epoch: 0 })
  const gateRef = useRef<ReturnType<typeof createApplicationTaskRequestGate> | null>(null)
  if (!gateRef.current) gateRef.current = createApplicationTaskRequestGate()
  useCommitEffect(() => {
    scopeRef.current = { owner: scope, epoch: scopeRef.current.epoch + 1 }
    return () => { scopeRef.current = { owner: null, epoch: scopeRef.current.epoch }; gateRef.current?.cancel() }
  }, [scope])
  const [snapshot, setSnapshot] = useState<Snapshot>({ owner: null, epoch: 0, loading: true, error: false, parsed: null })
  const refetch = useCallback(async () => {
    if (!scope || scopeRef.current.owner !== scope) return
    const epoch = scopeRef.current.epoch
    const request = gateRef.current!.start()
    const current = () => request.current() && scopeRef.current.owner === scope && scopeRef.current.epoch === epoch
    setSnapshot({ owner: scope, epoch, loading: true, error: false, parsed: null })
    let timedOut = false
    const timeout = setTimeout(() => { if (!current()) return; timedOut = true; gateRef.current?.cancel(); setSnapshot({ owner: scope, epoch, loading: false, error: true, parsed: null }) }, 30_000)
    try {
      const response = await fetch('/api/agent/application-tasks', { signal: request.signal, cache: 'no-store' })
      const data: unknown = await response.json()
      if (!current()) return
      const parsed = response.ok ? parseApplicationTasks(data, scope) : null
      setSnapshot({ owner: scope, epoch, loading: false, error: !parsed, parsed })
    } catch {
      if (current() && !timedOut) setSnapshot({ owner: scope, epoch, loading: false, error: true, parsed: null })
    } finally { clearTimeout(timeout) }
  }, [scope])

  useEffect(() => {
    if (scope) void refetch()
    return () => gateRef.current?.cancel()
  }, [refetch, scope])

  const visible = active && isCurrentApplicationTaskSnapshot(scopeRef.current, snapshot, userId)
  const loading = enabled && (status === 'loading' || (active && (!visible || snapshot.loading)))
  const tasks = visible && !loading && !snapshot.error && snapshot.parsed ? snapshot.parsed.tasks : EMPTY_TASKS
  const byJobId = useMemo<ReadonlyMap<string, ApplicationTaskView>>(() => new Map(tasks.map(task => [task.jobId, task])), [tasks])
  return {
    tasks, byJobId, loading,
    error: (enabled && status === 'authenticated' && !userId) || (visible && !loading && (snapshot.error || !snapshot.parsed)) ? 'unavailable' as const : null,
    limited: Boolean(visible && !loading && !snapshot.error && snapshot.parsed?.limited),
    refetch,
  }
}
