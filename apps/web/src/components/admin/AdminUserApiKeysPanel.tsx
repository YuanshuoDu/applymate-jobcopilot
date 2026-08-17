'use client'

import React, { useEffect, useState } from 'react'
import { useAdminPrompt } from './AdminPromptDialog'
import { adminMutationHeaders } from '@/lib/admin/client'
import { useI18n } from '@/lib/i18n'

type ApiKeyStatus = {
  id: string
  providers: { adzuna: boolean; rapidapi: boolean }
  createdAt: string
  updatedAt: string
}

export function AdminUserApiKeysPanel({ userId, canRevoke }: { userId: string; canRevoke: boolean }) {
  const { t } = useI18n()
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
    const response = await fetch(`/api/admin/v1/users/${userId}/api-keys`, { method: 'DELETE', headers: { ...adminMutationHeaders({ json: false }), 'x-admin-reason': reason } })
    const payload = await response.json().catch(() => null) as { error?: string; revoked?: boolean } | null
    setNotice(response.ok ? (payload?.revoked ? t('adminKeys.revoked') : t('adminKeys.none')) : payload?.error ?? t('adminKeys.empty'))
    if (response.ok) await load()
    setBusy(false)
  }

  return (
    <>
      <section className="admin-detail-settings">
        <div className="admin-settings-heading">
          <div><h2>{t('adminKeys.title')}</h2><p>{t('adminKeys.description')}</p></div>
          <span role="status">{notice}</span>
        </div>
        {loading ? <p className="admin-settings-empty">{t('adminKeys.loading')}</p> : !keys ? <p className="admin-settings-empty">{t('adminKeys.empty')}</p> : (
          <>
            <div className="admin-settings-status-list"><span>Adzuna: {keys.providers.adzuna ? t('adminKeys.configured') : t('adminKeys.notConfigured')}</span><span>RapidAPI: {keys.providers.rapidapi ? t('adminKeys.configured') : t('adminKeys.notConfigured')}</span><span>{t('adminKeys.updated')}: {new Date(keys.updatedAt).toLocaleString()}</span></div>
            {canRevoke && <div className="admin-inline-actions"><button className="admin-row-action" type="button" disabled={busy} onClick={() => void revoke()}>{t('adminKeys.revokeAll')}</button></div>}
          </>
        )}
      </section>
      {dialog}
    </>
  )
}
