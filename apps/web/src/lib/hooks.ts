'use client'

import { useState, useEffect, useCallback } from 'react'

// ── Generic GET hook ──────────────────────────────────────────────────────────

/** SWR-style hook: fetches `url` on mount and when `url` changes */
export function useApi<T>(url: string) {
  const [data,    setData   ] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError  ] = useState<string | null>(null)

  const refetch = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res  = await fetch(url)
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((json as { error?: string }).error ?? 'Request failed')
      setData(json as T)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [url])

  useEffect(() => { refetch() }, [refetch])

  return { data, loading, error, refetch }
}

// ── One-off mutation ──────────────────────────────────────────────────────────

/** Fire-and-forget POST / PATCH / DELETE — returns `{ data, error }` */
export async function apiMutate<T = unknown>(
  url: string,
  method: 'POST' | 'PATCH' | 'DELETE' = 'PATCH',
  body?: unknown,
): Promise<{ data: T | null; error: string | null }> {
  try {
    const res  = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
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
