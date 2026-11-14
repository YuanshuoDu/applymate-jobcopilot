'use client'

import React from 'react'
import { useCallback, useEffect, useState } from 'react'

type Consent = { enabled: boolean; version: number }
const ENDPOINT = '/api/me/agent-search-footprint-memory'
const MAX_CONSENT_VERSION = 2_147_483_647
const ENABLED_AT_LIMIT_MESSAGE = 'Search history is unavailable. You can turn off the saved choice here, but it cannot be turned on again.'
const DISABLED_AT_LIMIT_MESSAGE = 'Search history is unavailable and this choice is off. It cannot be turned on again.'

function parseConsent(value: unknown): Consent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  return typeof row.enabled === 'boolean' && Number.isSafeInteger(row.version)
    && Number(row.version) >= 0 && Number(row.version) <= MAX_CONSENT_VERSION
    ? { enabled: row.enabled, version: Number(row.version) } : null
}

type ConsentSaveResult =
  | { kind: 'saved'; consent: Consent }
  | { kind: 'conflict'; consent: Consent }
  | { kind: 'exhausted'; consent: Consent }
  | { kind: 'invalid' }

function parseConsentSaveResponse(status: number, value: unknown): ConsentSaveResult {
  const consent = parseConsent(value)
  if (!consent) return { kind: 'invalid' }
  if (status === 409 && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const error = (value as Record<string, unknown>).error
    if (error === 'VERSION_EXHAUSTED' && consent.version === MAX_CONSENT_VERSION) return { kind: 'exhausted', consent }
    if (error === 'VERSION_CONFLICT') return consent.version === MAX_CONSENT_VERSION
      ? { kind: 'exhausted', consent }
      : { kind: 'conflict', consent }
  }
  return status === 200 ? { kind: 'saved', consent } : { kind: 'invalid' }
}

export function AgentSearchFootprintMemoryConsent() {
  const [consent, setConsent] = useState<Consent | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch(ENDPOINT, { cache: 'no-store' })
      const current = parseConsent(await response.json())
      if (!response.ok || !current) throw new Error('Could not load this setting.')
      setConsent(current)
      setMessage('')
    } catch {
      setMessage('Could not load this setting. Try again.')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void reload() }, [reload])

  async function update(enabled: boolean) {
    if (!consent || saving) return
    setSaving(true)
    setMessage('')
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, expectedVersion: consent.version }),
      })
      const result = parseConsentSaveResponse(response.status, await response.json().catch(() => null))
      if (result.kind === 'invalid') throw new Error('Could not save this setting. Try again.')
      setConsent(result.consent)
      setMessage(result.kind === 'conflict' ? 'This setting changed elsewhere. The latest saved choice is shown.' : '')
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : 'Could not save this setting. Try again.')
    } finally { setSaving(false) }
  }

  const unavailable = consent?.version === MAX_CONSENT_VERSION
  const lockedOff = unavailable && consent?.enabled === false

  return (
    <section aria-labelledby="search-footprint-memory-title" style={{ margin: '0 10px 12px', padding: 10, border: '1px solid var(--border)', borderRadius: 8 }}>
      <div id="search-footprint-memory-title" style={{ fontSize: 11, fontWeight: 700 }}>Search criteria memory</div>
      <p style={{ margin: '5px 0 8px', color: 'var(--text-muted)', fontSize: 10, lineHeight: 1.5 }}>
        With your consent enabled, future sessions may refer to bounded role, location, and source criteria from earlier sessions as advisory context when available. Each objective still requires a fresh search. Separate from Task History; grants no action, approval, or submission authority.
      </p>
      {unavailable && <div role="status" style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 10 }}>
        {consent?.enabled ? ENABLED_AT_LIMIT_MESSAGE : DISABLED_AT_LIMIT_MESSAGE}
      </div>}
      <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, cursor: loading || saving || !consent || lockedOff ? 'wait' : 'pointer' }}>
        <input
          type="checkbox"
          aria-label="Allow future sessions to refer to bounded search criteria"
          checked={consent?.enabled ?? false}
          disabled={loading || saving || !consent || lockedOff}
          onChange={event => { void update(event.currentTarget.checked) }}
        />
        {loading ? 'Loading…' : unavailable && consent?.enabled ? 'On (unavailable)' : consent?.enabled ? 'On' : 'Off'}
      </label>
      {message && <div role="status" style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 10 }}>{message}</div>}
      {!loading && !consent && <button type="button" onClick={() => { void reload() }} style={{ marginTop: 6 }}>Retry</button>}
    </section>
  )
}
