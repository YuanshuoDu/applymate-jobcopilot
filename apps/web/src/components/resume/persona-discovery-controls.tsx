'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useI18n, type Lang } from '@/lib/i18n'
import { isDiscoveryPersonaFactEnabled, personaDiscoveryMessage } from '@/lib/persona-discovery-messages'
import type { DiscoveryPersonaFact } from '@/lib/persona-facts'

const FACT_LIMIT = 32 as const
const BYTE_LIMIT = 8192 as const

export type PersonaDiscoveryCapacity = {
  status: 'available' | 'overflow' | 'unknown'
  factCount: number
  factLimit: typeof FACT_LIMIT
  canonicalUtf8Bytes: number | null
  byteLimit: typeof BYTE_LIMIT
  overflowReason?: 'fact_limit' | 'byte_limit'
}

type DiscoverySettings = { facts: DiscoveryPersonaFact[]; capacity: PersonaDiscoveryCapacity }
export type DiscoveryLoadResult = 'loaded' | 'failed' | 'superseded'
type ConsentChange = { kind: 'updated'; fact: DiscoveryPersonaFact } | { kind: 'stale' } | { kind: 'stale_refresh_failed' } | { kind: 'stale_refresh_superseded' } | { kind: 'failed' }

function unknownCapacity(factCount = 0): PersonaDiscoveryCapacity {
  return { status: 'unknown', factCount, factLimit: FACT_LIMIT, canonicalUtf8Bytes: null, byteLimit: BYTE_LIMIT }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function parsePersonaDiscoveryCapacity(value: unknown): PersonaDiscoveryCapacity {
  if (!isRecord(value)) return unknownCapacity()
  const count = isCount(value.factCount) ? value.factCount : 0
  if (value.status === 'unknown') return unknownCapacity(count)
  if (value.factLimit !== FACT_LIMIT || value.byteLimit !== BYTE_LIMIT || !isCount(value.factCount)) return unknownCapacity()
  if (value.status === 'available' && value.factCount <= FACT_LIMIT && isCount(value.canonicalUtf8Bytes) &&
    value.canonicalUtf8Bytes <= BYTE_LIMIT && value.overflowReason === undefined) {
    return { status: 'available', factCount: count, factLimit: FACT_LIMIT, canonicalUtf8Bytes: value.canonicalUtf8Bytes, byteLimit: BYTE_LIMIT }
  }
  if (value.status === 'overflow' && value.factCount > FACT_LIMIT && value.canonicalUtf8Bytes === null && value.overflowReason === 'fact_limit') {
    return { status: 'overflow', factCount: count, factLimit: FACT_LIMIT, canonicalUtf8Bytes: null, byteLimit: BYTE_LIMIT, overflowReason: 'fact_limit' }
  }
  if (value.status === 'overflow' && value.factCount <= FACT_LIMIT && isCount(value.canonicalUtf8Bytes) &&
    value.canonicalUtf8Bytes > BYTE_LIMIT && value.overflowReason === 'byte_limit') {
    return { status: 'overflow', factCount: count, factLimit: FACT_LIMIT, canonicalUtf8Bytes: value.canonicalUtf8Bytes, byteLimit: BYTE_LIMIT, overflowReason: 'byte_limit' }
  }
  return unknownCapacity()
}

export function parseDiscoverySettings(payload: unknown): DiscoverySettings | null {
  if (!isRecord(payload) || !Array.isArray(payload.facts) || !payload.facts.every(isDiscoveryPersonaFact)) return null
  return { facts: payload.facts as DiscoveryPersonaFact[], capacity: parsePersonaDiscoveryCapacity(payload.capacity) }
}

export function createDiscoveryRequestFence() {
  let latestRequest = 0
  return {
    begin: () => ++latestRequest,
    invalidate: () => { latestRequest += 1 },
    isCurrent: (request: number) => request === latestRequest,
  }
}

export function classifyDiscoveryLoadResult(isCurrent: boolean, successful: boolean): DiscoveryLoadResult {
  if (!isCurrent) return 'superseded'
  return successful ? 'loaded' : 'failed'
}

export async function requestDiscoveryConsentChange(
  fact: DiscoveryPersonaFact, enabled: boolean, refresh: () => Promise<DiscoveryLoadResult | void>, fetcher: typeof fetch = fetch,
): Promise<ConsentChange> {
  try {
    const response = await fetcher('/api/me/persona/discovery', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ factId: fact.id, key: fact.key, expectedValue: fact.value,
        expectedNormalizedValue: fact.normalizedValue, expectedUpdatedAt: fact.updatedAt, enabled }),
    })
    if (response.status === 409 || response.status === 404) {
      try {
        const result = await refresh()
        if (result === 'failed') return { kind: 'stale_refresh_failed' }
        if (result === 'superseded') return { kind: 'stale_refresh_superseded' }
      } catch { return { kind: 'stale_refresh_failed' } }
      return { kind: 'stale' }
    }
    if (!response.ok) return { kind: 'failed' }
    const payload: unknown = await response.json().catch(() => null)
    if (!isRecord(payload) || !isDiscoveryPersonaFact(payload.fact)) return { kind: 'failed' }
    return { kind: 'updated', fact: payload.fact }
  } catch { return { kind: 'failed' } }
}

function isDiscoveryPersonaFact(value: unknown): value is DiscoveryPersonaFact {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' && typeof value.key === 'string' && typeof value.category === 'string' &&
    typeof value.label === 'string' && typeof value.value === 'string' && typeof value.normalizedValue === 'string' &&
    typeof value.source === 'string' && Array.isArray(value.allowedUses) && value.allowedUses.every(use => typeof use === 'string') &&
    typeof value.updatedAt === 'string' && (typeof value.expiresAt === 'string' || value.expiresAt === null)
}

export function PersonaDiscoveryCapacitySummary({ capacity, lang }: { capacity: PersonaDiscoveryCapacity; lang: Lang }) {
  const key = capacity.status === 'unknown' ? 'capacityUnknown'
    : capacity.overflowReason === 'fact_limit' ? 'capacityFactOverflow'
      : capacity.overflowReason === 'byte_limit' ? 'capacityByteOverflow' : 'capacityAvailable'
  return <p role="status" aria-live="polite" aria-atomic="true" style={capacityStyle}>
    {personaDiscoveryMessage(lang, key, {
      factCount: capacity.factCount, factLimit: capacity.factLimit,
      bytes: capacity.canonicalUtf8Bytes ?? 0, byteLimit: capacity.byteLimit,
    })}
  </p>
}

export function PersonaDiscoveryFactRow({ fact, lang, busy, onChange }: {
  fact: DiscoveryPersonaFact; lang: Lang; busy: boolean; onChange: (enabled: boolean) => void
}) {
  const enabled = isDiscoveryPersonaFactEnabled(fact.allowedUses)
  return <label style={discoveryFactStyle}>
    <input aria-label={`${personaDiscoveryMessage(lang, 'useFact')}: ${fact.label}`} type="checkbox" checked={enabled} disabled={busy} onChange={event => onChange(event.currentTarget.checked)} />
    <span style={{ display: 'grid', gap: 2 }}><strong>{fact.label}</strong><small>{fact.value}</small><small>{personaDiscoveryMessage(lang, enabled ? 'enabled' : 'disabled')}</small></span>
  </label>
}

export function PersonaDiscoveryFactList({ facts, loading, failed, busy, lang, onChange }: {
  facts: DiscoveryPersonaFact[]; loading: boolean; failed: boolean; busy: Record<string, boolean>; lang: Lang
  onChange: (fact: DiscoveryPersonaFact, enabled: boolean) => void
}) {
  if (loading || failed) return null
  if (facts.length === 0) return <small>{personaDiscoveryMessage(lang, 'empty')}</small>
  return <>{facts.map(fact => <PersonaDiscoveryFactRow key={fact.id} fact={fact} lang={lang} busy={Boolean(busy[fact.id])} onChange={enabled => onChange(fact, enabled)} />)}</>
}

export function PersonaDiscoveryLoadError({ message }: { message: string }) {
  return message ? <p role="alert" style={errorStyle}>{message}</p> : null
}

export function PersonaDiscoveryControls({ refreshKey }: { refreshKey: number }) {
  const { lang } = useI18n()
  const requestFence = useMemo(() => createDiscoveryRequestFence(), [])
  const [facts, setFacts] = useState<DiscoveryPersonaFact[]>([])
  const [capacity, setCapacity] = useState<PersonaDiscoveryCapacity>(() => unknownCapacity())
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<Record<string, boolean>>({})

  const load = useCallback(async (): Promise<DiscoveryLoadResult> => {
    const request = requestFence.begin()
    setLoading(true); setLoadFailed(false); setError(''); setCapacity(unknownCapacity())
    try {
      const response = await fetch('/api/me/persona/discovery')
      const payload: unknown = await response.json().catch(() => null)
      const settings = response.ok ? parseDiscoverySettings(payload) : null
      if (!settings) throw new Error('load')
      const result = classifyDiscoveryLoadResult(requestFence.isCurrent(request), true)
      if (result !== 'loaded') return result
      setFacts(settings.facts); setCapacity(settings.capacity)
      return result
    } catch {
      const result = classifyDiscoveryLoadResult(requestFence.isCurrent(request), false)
      if (result !== 'failed') return result
      setFacts([]); setCapacity(unknownCapacity()); setLoadFailed(true); setError(personaDiscoveryMessage(lang, 'loadFailed'))
      return result
    } finally {
      if (requestFence.isCurrent(request)) setLoading(false)
    }
  }, [lang, requestFence])

  useEffect(() => { void load() }, [load, refreshKey])

  async function changeConsent(fact: DiscoveryPersonaFact, enabled: boolean) {
    setBusy(current => ({ ...current, [fact.id]: true }))
    const result = await requestDiscoveryConsentChange(fact, enabled, load)
    if (result.kind === 'updated') {
      requestFence.invalidate()
      setFacts(current => current.map(item => item.id === result.fact.id ? result.fact : item))
      await load()
    } else if (result.kind === 'stale') setError(personaDiscoveryMessage(lang, 'stale'))
    else if (result.kind === 'stale_refresh_failed') setError(personaDiscoveryMessage(lang, 'loadFailed'))
    else if (result.kind === 'stale_refresh_superseded') { /* The newer read owns the visible state. */ }
    else setError(personaDiscoveryMessage(lang, 'saveFailed'))
    setBusy(current => ({ ...current, [fact.id]: false }))
  }

  return <section data-persona-discovery-consent="true" aria-busy={loading} style={discoveryBoxStyle}>
    <div style={panelTitleStyle}>{personaDiscoveryMessage(lang, 'title')}</div>
    <p style={discoveryDisclosureStyle}>{personaDiscoveryMessage(lang, 'disclosure')}</p>
    <p style={capacityNoteStyle}>{personaDiscoveryMessage(lang, 'capacityNote')}</p>
    {loading ? <small role="status" aria-live="polite">{personaDiscoveryMessage(lang, 'loading')}</small>
      : <PersonaDiscoveryCapacitySummary capacity={capacity} lang={lang} />}
    <PersonaDiscoveryLoadError message={error} />
    <PersonaDiscoveryFactList facts={facts} loading={loading} failed={loadFailed} busy={busy} lang={lang}
      onChange={(fact, enabled) => void changeConsent(fact, enabled)} />
  </section>
}

const discoveryBoxStyle = { padding: 9, margin: '10px 0 12px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)' }
const panelTitleStyle = { fontSize: 10, color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase' as const, margin: '10px 0 6px' }
const discoveryDisclosureStyle = { margin: '4px 0 8px', color: 'var(--text-muted)', fontSize: 10, lineHeight: 1.5 }
const capacityNoteStyle = { margin: '4px 0 8px', color: 'var(--text-muted)', fontSize: 10, lineHeight: 1.5 }
const capacityStyle = { margin: '4px 0 8px', fontSize: 11, lineHeight: 1.4 }
const errorStyle = { color: '#b42318', fontSize: 11, margin: '6px 0' }
const discoveryFactStyle = { display: 'flex', alignItems: 'start', gap: 8, padding: '7px 0', borderTop: '1px solid var(--border)', fontSize: 11 }
