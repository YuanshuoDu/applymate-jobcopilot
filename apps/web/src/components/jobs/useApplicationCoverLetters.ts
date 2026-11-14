'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CoverLetter } from '@/lib/types'

type Scope = { key: string | null; epoch: number }
type Snapshot = { key: string; epoch: number; loading: boolean; letter: CoverLetter | null }
type Result = { kind: 'ready'; letter: CoverLetter; current: () => boolean } | { kind: 'unavailable' | 'superseded' | 'unselected' }
const useCommitEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/** Reject malformed, duplicated or misbound selected records. */
export function parseSelectedCoverLetter(value: unknown, userId: string, jobId: string, selectedId: string): CoverLetter | null {
  if (!userId || !jobId || !selectedId || !Array.isArray(value)) return null
  if (value.some(row => !row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || !row.id.trim())) return null
  const matches = value.filter(row => row.id === selectedId)
  if (matches.length !== 1) return null
  const row = matches[0] as Record<string, unknown>
  if (row.userId !== userId || row.jobId !== jobId || typeof row.content !== 'string'
    || typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt))) return null
  return row as unknown as CoverLetter
}

/** Cancel resolves even when a fetch implementation ignores its signal. */
export function createCoverLetterRequestGate() {
  let generation = 0
  let active: { controller: AbortController; resolve: () => void } | null = null
  const cancel = () => { generation++; active?.controller.abort(); active?.resolve(); active = null }
  return {
    cancel,
    start() {
      cancel()
      const id = generation
      const controller = new AbortController()
      let resolve = () => {}
      const cancelled = new Promise<void>(done => { resolve = done })
      active = { controller, resolve }
      return { signal: controller.signal, current: () => generation === id, cancelled }
    },
  }
}

/** One selected letter per committed account/job/selection; no cached snapshots. */
export function useApplicationCoverLetters(userId: string | null, jobId: string, jobUserId: string, selectedId: string | null) {
  const key = userId && jobUserId === userId && jobId ? JSON.stringify([userId, jobId, selectedId]) : null
  const scopeRef = useRef<Scope>({ key: null, epoch: 0 })
  const gateRef = useRef<ReturnType<typeof createCoverLetterRequestGate> | null>(null)
  const latestRef = useRef<{ key: string; epoch: number; promise: Promise<Result> } | null>(null)
  if (!gateRef.current) gateRef.current = createCoverLetterRequestGate()
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)

  useCommitEffect(() => {
    scopeRef.current = { key, epoch: scopeRef.current.epoch + 1 }
    return () => { scopeRef.current = { key: null, epoch: scopeRef.current.epoch }; gateRef.current?.cancel() }
  }, [key])

  const refetch = useCallback((): Promise<Result> => {
    if (!selectedId) return Promise.resolve({ kind: 'unselected' })
    if (!key || !userId || scopeRef.current.key !== key) return Promise.resolve({ kind: 'unavailable' })
    const epoch = scopeRef.current.epoch
    const request = gateRef.current!.start()
    const current = () => request.current() && scopeRef.current.key === key && scopeRef.current.epoch === epoch
    setSnapshot({ key, epoch, loading: true, letter: null })
    const promise = (async (): Promise<Result> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const outcome = await Promise.race([
          fetch(`/api/jobs/${encodeURIComponent(jobId)}/cover-letters`, { signal: request.signal, cache: 'no-store' })
            .then(async response => response.ok ? { kind: 'response' as const, value: await response.json() as unknown } : { kind: 'failure' as const })
            .catch(() => ({ kind: 'failure' as const })),
          request.cancelled.then(() => ({ kind: 'cancelled' as const })),
          new Promise<{ kind: 'timeout' }>(resolve => { timer = setTimeout(() => resolve({ kind: 'timeout' }), 30_000) }),
        ])
        if (!current()) return { kind: 'superseded' }
        if (outcome.kind !== 'response') {
          gateRef.current!.cancel()
          setSnapshot({ key, epoch, loading: false, letter: null })
          return { kind: 'unavailable' }
        }
        const letter = parseSelectedCoverLetter(outcome.value, userId, jobId, selectedId)
        setSnapshot({ key, epoch, loading: false, letter })
        return letter ? { kind: 'ready', letter, current } : { kind: 'unavailable' }
      } finally { if (timer) clearTimeout(timer) }
    })()
    latestRef.current = { key, epoch, promise }
    return promise
  }, [key, userId, jobId, selectedId])

  /** Wait at most 30 seconds for the latest read within this committed scope. */
  const waitForLatest = useCallback(async (timeoutMs = 30_000): Promise<Result> => {
    if (!selectedId) return { kind: 'unselected' }
    if (!key || scopeRef.current.key !== key) return { kind: 'unavailable' }
    const epoch = scopeRef.current.epoch
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async (): Promise<Result> => {
      while (!stopped && scopeRef.current.key === key && scopeRef.current.epoch === epoch) {
        const latest = latestRef.current
        if (!latest || latest.key !== key || latest.epoch !== epoch) return { kind: 'unavailable' }
        const result = await latest.promise
        if (stopped) return { kind: 'unavailable' }
        if (scopeRef.current.key !== key || scopeRef.current.epoch !== epoch) return { kind: 'superseded' }
        if (latestRef.current !== latest) continue
        return result.kind === 'ready' && !result.current() ? { kind: 'superseded' } : result
      }
      return { kind: 'superseded' }
    }
    try {
      return await Promise.race([read(), new Promise<Result>(resolve => { timer = setTimeout(() => resolve({ kind: 'unavailable' }), Math.max(1, timeoutMs)) })])
    } finally { stopped = true; if (timer) clearTimeout(timer) }
  }, [key, selectedId])

  const captureScope = useCallback(() => {
    const epoch = scopeRef.current.epoch
    return () => key !== null && scopeRef.current.key === key && scopeRef.current.epoch === epoch
  }, [key])

  useEffect(() => {
    if (key && selectedId) void refetch()
    return () => gateRef.current?.cancel()
  }, [key, selectedId, refetch])

  const visible = key !== null && scopeRef.current.key === key && snapshot?.key === key && snapshot.epoch === scopeRef.current.epoch
  return {
    letter: visible && !snapshot.loading ? snapshot.letter : null,
    loading: Boolean(selectedId && key && (!visible || snapshot.loading)),
    refetch,
    waitForLatest,
    captureScope,
  }
}
