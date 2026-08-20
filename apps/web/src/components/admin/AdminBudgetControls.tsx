'use client'

import { Save } from 'lucide-react'
import { useState } from 'react'
import { useAdminPrompt } from './AdminPromptDialog'
import { adminMutationHeaders } from '@/lib/admin/client'
import { useI18n } from '@/lib/i18n'

export function AdminBudgetControls({ canUpdate }: { canUpdate: boolean }) {
  const { t } = useI18n()
  const [userId, setUserId] = useState('')
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7))
  const [limit, setLimit] = useState(30)
  const [version, setVersion] = useState(1)
  const [notice, setNotice] = useState('')
  const { request, dialog } = useAdminPrompt()
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const reason = await request({ title: t('aiBudget.override'), label: t('aiBudget.reason'), kind: 'reason' })
    if (!reason) return
    const response = await fetch(`/api/admin/v1/ai/budgets/${encodeURIComponent(userId)}/${month}`, { method: 'PATCH', headers: adminMutationHeaders(), body: JSON.stringify({ limit, version, reason, confirmBelowUsed: true }) })
    const payload = await response.json().catch(() => null) as { error?: string; version?: number } | null
    if (!response.ok) { setNotice(payload?.error ?? t('aiBudget.overrideFailed')); return }
    setVersion(payload?.version ?? version + 1)
    setNotice(t('aiBudget.saved'))
  }
  return <><section className="admin-controls"><div className="admin-controls-title"><div><h2>{t('aiBudget.title')}</h2><p>{t('aiBudget.description')}</p></div><span role="status">{notice}</span></div><form className="budget-control-form" onSubmit={(event) => void submit(event)}><label>{t('aiBudget.userId')}<input value={userId} onChange={(event) => setUserId(event.target.value)} required /></label><label>{t('aiBudget.month')}<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} required /></label><label>{t('aiBudget.creditLimit')}<input type="number" min="0" max="10000" value={limit} onChange={(event) => setLimit(Number(event.target.value))} required /></label><label>{t('aiBudget.version')}<input type="number" min="1" value={version} onChange={(event) => setVersion(Number(event.target.value))} required /></label><button className="admin-secondary" type="submit" disabled={!canUpdate}><Save size={15} /> {t('aiBudget.save')}</button></form></section>{dialog}</>
}
