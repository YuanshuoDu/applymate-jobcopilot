'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { getCachedApiResponse, setCachedApiResponse } from './api-cache'

// ── Generic GET hook ──────────────────────────────────────────────────────────

/**
 * SWR-style GET hook. Cached data is displayed immediately after tab navigation
 * while a fresh request runs in the background; explicit refetches still show
 * the existing loading state.
 */
export function useApi<T>(url: string, options: { cache?: boolean; enabled?: boolean; timeoutMs?: number } = {}) {
  const { data: session, status } = useSession()
  const userId = status === 'authenticated' ? session.user?.id ?? null : null
  const cacheEnabled = options.cache !== false
  const enabled = options.enabled !== false
  const timeoutMs = options.timeoutMs ?? 30_000
  const initial = enabled && cacheEnabled ? getCachedApiResponse<T>(url, userId) : null
  const [data,    setData   ] = useState<T | null>(() => initial)
  const [loading, setLoading] = useState(() => initial === null)
  const [error,   setError  ] = useState<string | null>(null)

  const load = useCallback(async (showLoading: boolean, signal?: AbortSignal) => {
    if (!enabled) {
      setLoading(false)
      setError(null)
      return
    }
    if (showLoading) setLoading(true)
    setError(null)
    let timedOut = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let requestController: AbortController | undefined
    let abortRequest: (() => void) | undefined
    let requestSignal = signal
    if (timeoutMs > 0) {
      requestController = new AbortController()
      abortRequest = () => requestController?.abort()
      if (signal?.aborted) requestController.abort()
      else signal?.addEventListener('abort', abortRequest, { once: true })
      timeoutId = setTimeout(() => {
        timedOut = true
        requestController?.abort()
      }, timeoutMs)
      requestSignal = requestController.signal
    }
    try {
      const res  = await fetch(url, { signal: requestSignal, cache: cacheEnabled ? 'default' : 'no-store' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((json as { error?: string }).error ?? 'Request failed')
      const nextData = json as T
      if (cacheEnabled) setCachedApiResponse(url, nextData, userId)
      setData(nextData)
    } catch (e) {
      if (timedOut) {
        setError(`Request timed out after ${Math.ceil(timeoutMs / 1000)} seconds. Try refreshing.`)
        return
      }
      if (e instanceof DOMException && e.name === 'AbortError') return
      // Preserve usable cached data if a background refresh temporarily fails.
      if (!cacheEnabled || getCachedApiResponse<T>(url, userId) === null) {
        setError(e instanceof Error ? e.message : 'Unknown error')
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
      if (signal && abortRequest) signal.removeEventListener('abort', abortRequest)
      if (!signal?.aborted) setLoading(false)
    }
  }, [url, userId, cacheEnabled, enabled, timeoutMs])

  const refetch = useCallback(() => load(true), [load])

  useEffect(() => {
    if (!enabled) {
      setData(null)
      setLoading(false)
      setError(null)
      return
    }
    const cached = cacheEnabled ? getCachedApiResponse<T>(url, userId) : null
    const controller = new AbortController()
    // URLs can change while a page remains mounted (for example the Dashboard
    // week picker). Reset to that URL's cached response rather than retaining
    // data from a previous filter.
    setData(cached)
    setLoading(cached === null)
    void load(cached === null, controller.signal)
    return () => controller.abort()
  }, [load, url, userId, cacheEnabled, enabled])

  return { data, loading, error, refetch }
}

export async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Request timed out after ${Math.ceil(timeoutMs / 1000)} seconds. Try refreshing.`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

// ── One-off mutation ──────────────────────────────────────────────────────────

/** Fire-and-forget POST / PATCH / DELETE — returns `{ data, error }` */
export async function apiMutate<T = unknown>(
  url: string,
  method: 'POST' | 'PATCH' | 'DELETE' = 'PATCH',
  body?: unknown,
): Promise<{ data: T | null; error: string | null }> {
  try {
    const headers: Record<string, string> = body !== undefined ? { 'Content-Type': 'application/json' } : {}
    headers['Idempotency-Key'] = crypto.randomUUID()
    const res  = await fetch(url, {
      method,
      headers,
      body:    body !== undefined ? JSON.stringify(body) : undefined,
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return { data: null, error: (json as { error?: string }).error ?? 'Request failed' }
    return { data: json as T, error: null }
  } catch {
    return { data: null, error: 'Network error' }
  }
}

// ── Date helpers ──────────────────────────────────────────────────────────────

/** "Apr 22" */
export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return ''
  return new Date(d).toLocaleDateString('en', { month: 'short', day: 'numeric' })
}

/** "2 hours ago" / "Yesterday" / "Apr 22" */
export function fmtRelative(d: string | Date | null | undefined): string {
  if (!d) return ''
  const diff  = Date.now() - new Date(d).getTime()
  const mins  = Math.floor(diff / 60_000)
  if (mins  <  2) return 'Just now'
  if (mins  < 60) return `${mins} mins ago`
  const hours = Math.floor(mins  / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days  = Math.floor(hours / 24)
  if (days  === 1) return 'Yesterday'
  if (days  <   7) return `${days} days ago`
  return fmtDate(d)
}
