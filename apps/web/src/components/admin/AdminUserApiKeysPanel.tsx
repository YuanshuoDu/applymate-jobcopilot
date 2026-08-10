'use client'

import React, { useEffect, useState } from 'react'
import { useAdminPrompt } from './AdminPromptDialog'

type ApiKeyStatus = {
  id: string
  providers: { adzuna: boolean; rapidapi: boolean }
  createdAt: string
  updatedAt: string
}

export function AdminUserApiKeysPanel({ userId, canRevoke }: { userId: string; canRevoke: boolean }) {
  const [keys, setKeys] = useState<ApiKeyStatus | null>(null)
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const { request, dialog } = useAdminPrompt()

  async function load() {
    setLoading(true)
    const response = await fetch(`/api/admin/v1/users/${userId}/api-keys`, { cache: 'no-store' })
    const payload = await response.json().catch(() => null) as { keys?: ApiKeyStatus | null; error?: string } | null
    setKeys(payload?.keys ?? null)
    if (!response.ok) setNotice(payload?.error ?? 'Unable to load user API key status.')
    setLoading(false)
  }

  useEffect(() => { void load() }, [userId])

  async function revoke() {
    const reason = await request({ title: 'Revoke user API keys', label: 'Audit reason', kind: 'reason', description: 'This permanently removes the user-managed provider credentials from ApplyMate.' })
    if (!reason) return
    setBusy(true)
    const response = await fetch(`/api/admin/v1/users/${userId}/api-keys`, { method: 'DELETE', headers: { 'x-admin-reason': reason, 'Idempotency-Key': crypto.randomUUID() } })
    const payload = await response.json().catch(() => null) as { error?: string; revoked?: boolean } | null
    setNotice(response.ok ? (payload?.revoked ? 'User API keys revoked.' : 'No user API keys were present.') : payload?.error ?? 'Unable to revoke user API keys.')
    if (response.ok) await load()
    setBusy(false)
  }

  return (
    <>
      <section className="admin-detail-settings">
        <div className="admin-settings-heading">
          <div><h2>User API keys</h2><p>Only provider presence is shown; secret values are never returned.</p></div>
          <span role="status">{notice}</span>
        </div>
        {loading ? <p className="admin-settings-empty">Loading key status...</p> : !keys ? <p className="admin-settings-empty">No user-managed provider keys are configured.</p> : (
          <>
            <div className="admin-settings-status-list"><span>Adzuna: {keys.providers.adzuna ? 'configured' : 'not configured'}</span><span>RapidAPI: {keys.providers.rapidapi ? 'configured' : 'not configured'}</span><span>Updated: {new Date(keys.updatedAt).toLocaleString()}</span></div>
            {canRevoke && <div className="admin-inline-actions"><button className="admin-row-action" type="button" disabled={busy} onClick={() => void revoke()}>Revoke all keys</button></div>}
          </>
        )}
      </section>
      {dialog}
    </>
  )
}
