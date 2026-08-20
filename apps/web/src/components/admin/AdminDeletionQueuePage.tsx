'use client'

import { RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAdminPrompt } from './AdminPromptDialog'
import { adminMutationHeaders } from '@/lib/admin/client'
import { useI18n } from '@/lib/i18n'

type DeletionRequest = { id: string; status: string; reason: string | null; requestedAt: string; processedAt: string | null; version: number; user: { name: string | null; email: string; plan: string; accountStatus: string } | null }
type RetentionPolicy = { key: string; name: string; retentionDays: number; enabled: boolean; version: number }

export function AdminDeletionQueuePage() {
  const { t } = useI18n()
  const [items, setItems] = useState<DeletionRequest[]>([])
  const [status, setStatus] = useState('')
  const [selected, setSelected] = useState<DeletionRequest | null>(null)
  const [nextStatus, setNextStatus] = useState('processing')
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [retention, setRetention] = useState<RetentionPolicy | null>(null)
  const [retentionDays, setRetentionDays] = useState('90')
  const [retentionEnabled, setRetentionEnabled] = useState(true)
  const { request, dialog } = useAdminPrompt()
  const planLabel = (value: string) => value === 'free' ? t('admin.free') : value === 'pro' ? t('admin.pro') : value === 'enterprise' ? t('admin.enterprise') : value
  const statusLabel = (value: string) => value === 'requested' ? t('deletionQueue.requested') : value === 'processing' ? t('deletionQueue.processing') : value === 'completed' ? t('deletionQueue.completed') : value === 'cancelled' ? t('deletionQueue.cancelled') : value

  async function load() {
    setLoading(true)
    const response = await fetch(`/api/admin/v1/users/deletions?limit=100${status ? `&status=${encodeURIComponent(status)}` : ''}`, { cache: 'no-store' })
    const payload = await response.json().catch(() => null) as { items?: DeletionRequest[]; error?: string } | null
    setItems(payload?.items ?? [])
    setSelectedIds(current => current.filter(id => (payload?.items ?? []).some(item => item.id === id)))
    if (!response.ok) setNotice(payload?.error ?? t('deletionQueue.loadFailed'))
    setLoading(false)
  }
  useEffect(() => { void load() }, [status])
  useEffect(() => { void fetch('/api/admin/v1/users/deletions/retention', { cache: 'no-store' }).then(response => response.json()).then(payload => { if (payload.policy) { setRetention(payload.policy); setRetentionDays(String(payload.policy.retentionDays)); setRetentionEnabled(payload.policy.enabled) } }).catch(() => undefined) }, [])

  async function saveRetention() {
    const confirmation = await request({ title: t('deletionQueue.saveRetention'), label: t('deletionQueue.reason'), kind: 'reason', description: t('deletionQueue.retentionDescription'), submitLabel: t('deletionQueue.savePolicy') })
    if (!confirmation || !retention) return
    const response = await fetch('/api/admin/v1/users/deletions/retention', { method: 'PATCH', headers: adminMutationHeaders(), body: JSON.stringify({ key: retention.key, retentionDays: Number(retentionDays), enabled: retentionEnabled, version: retention.version, reason: confirmation }) })
    const payload = await response.json().catch(() => null) as { policy?: RetentionPolicy; error?: string } | null
    if (response.ok && payload?.policy) { setRetention(payload.policy); setRetentionDays(String(payload.policy.retentionDays)); setRetentionEnabled(payload.policy.enabled); setNotice(t('deletionQueue.retentionSaved')) }
    else setNotice(payload?.error ?? t('deletionQueue.retentionFailed'))
  }

  async function update(event: React.FormEvent) {
    event.preventDefault()
    if (!selected || reason.trim().length < 10) return
    const response = await fetch(`/api/admin/v1/users/deletions/${selected.id}`, { method: 'PATCH', headers: adminMutationHeaders(), body: JSON.stringify({ status: nextStatus, version: selected.version, reason: reason.trim(), note: note.trim() }) })
    const payload = await response.json().catch(() => null) as { error?: string } | null
    setNotice(response.ok ? t('deletionQueue.updated') : payload?.error ?? t('deletionQueue.updateFailed'))
    if (response.ok) { setSelected(null); setReason(''); setNote(''); await load() }
  }

  async function bulkAdvance() {
    const targets = items.filter(item => selectedIds.includes(item.id) && ['requested', 'processing'].includes(item.status))
    if (!targets.length) return
    const confirmation = await request({ title: t('deletionQueue.advanceSelected'), label: t('deletionQueue.reason'), kind: 'reason', description: `${t('deletionQueue.advanceDescription')} ${targets.length} ${t(targets.length === 1 ? 'deletionQueue.request' : 'deletionQueue.requests')}.`, submitLabel: t('deletionQueue.advance') })
    if (!confirmation) return
    let completed = 0
    for (const item of targets) {
      const next = item.status === 'requested' ? 'processing' : 'completed'
      const response = await fetch(`/api/admin/v1/users/deletions/${item.id}`, { method: 'PATCH', headers: adminMutationHeaders(), body: JSON.stringify({ status: next, version: item.version, reason: confirmation, note: 'Bulk queue operation' }) })
      if (response.ok) completed += 1
    }
    setNotice(`${completed}/${targets.length} ${t('deletionQueue.advanced')}`)
    setSelectedIds([])
    await load()
  }

  return <><div className="admin-page"><header className="admin-header"><div><h1>{t('deletionQueue.title')}</h1><p>{t('deletionQueue.description')}</p></div><Trash2 size={22} aria-hidden="true" /></header><section className="admin-list-page"><div className="admin-queue-title"><span role="status">{notice}</span><div className="admin-inline-actions"><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">{t('deletionQueue.allStates')}</option><option value="requested">{t('deletionQueue.requested')}</option><option value="processing">{t('deletionQueue.processing')}</option><option value="completed">{t('deletionQueue.completed')}</option><option value="cancelled">{t('deletionQueue.cancelled')}</option></select><button className="admin-secondary" type="button" disabled={!selectedIds.length} onClick={() => void bulkAdvance()}>{t('deletionQueue.advanceSelected')} ({selectedIds.length})</button><button className="admin-row-action" type="button" title={t('deletionQueue.refresh')} onClick={() => void load()}><RefreshCw size={16} /></button></div></div>{retention && <section className="admin-retention-card"><div><h2>{t('deletionQueue.retention')}</h2><p>{t('deletionQueue.retentionDescription')}</p></div><div className="admin-inline-actions"><label>{t('deletionQueue.days')}<input type="number" min={1} max={3650} value={retentionDays} onChange={event => setRetentionDays(event.target.value)} /></label><label className="admin-operation-checkbox"><input type="checkbox" checked={retentionEnabled} onChange={event => setRetentionEnabled(event.target.checked)} /> {t('admin.enabled')}</label><button className="admin-secondary" type="button" onClick={() => void saveRetention()}>{t('deletionQueue.savePolicy')}</button></div></section>}<div className="admin-table-wrap"><table className="admin-table"><thead><tr><th><span className="sr-only">{t('common.select')}</span></th><th>{t('admin.user')}</th><th>{t('admin.plan')}</th><th>{t('admin.state')}</th><th>{t('deletionQueue.requestedAt')}</th><th>{t('deletionQueue.processedAt')}</th><th aria-label={t('admin.actions')} /></tr></thead><tbody>{loading ? <tr><td colSpan={7}>{t('common.loading')}…</td></tr> : items.length === 0 ? <tr><td colSpan={7}>{t('deletionQueue.empty')}</td></tr> : items.map((item) => { const selectable = ['requested', 'processing'].includes(item.status) && Boolean(item.user); return <tr key={item.id}><td><input type="checkbox" aria-label={`${t('deletionQueue.selectRequest')} ${item.user?.email ?? t('deletionQueue.deletedAccount')}`} disabled={!selectable} checked={selectedIds.includes(item.id)} onChange={(event) => setSelectedIds(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} /></td><td>{item.user ? `${item.user.name ?? t('admin.unnamed')} · ${item.user.email}` : t('deletionQueue.deletedTombstone')}</td><td>{item.user ? planLabel(item.user.plan) : '—'}</td><td>{statusLabel(item.status)}</td><td>{new Date(item.requestedAt).toLocaleString()}</td><td>{item.processedAt ? new Date(item.processedAt).toLocaleString() : '—'}</td><td>{item.status === 'requested' && item.user && <button className="admin-row-action" type="button" onClick={() => { setSelected(item); setNextStatus('processing') }}>{t('deletionQueue.start')}</button>}{item.status === 'processing' && item.user && <button className="admin-row-action" type="button" onClick={() => { setSelected(item); setNextStatus('completed') }}>{t('deletionQueue.complete')}</button>}</td></tr> })}</tbody></table></div></section>{selected && <div className="security-dialog-backdrop"><form className="security-card security-dialog" role="dialog" aria-modal="true" onSubmit={(event) => void update(event)}><h2>{nextStatus === 'completed' ? t('deletionQueue.completeRequest') : t('deletionQueue.startProcessing')}</h2><p>{selected.user?.email ?? t('deletionQueue.thisAccount')} · {t('deletionQueue.auditedIrreversible')}</p><label>{t('deletionQueue.reason')}<textarea required minLength={10} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} autoFocus /></label><label>{t('deletionQueue.processingNote')}<textarea maxLength={2000} value={note} onChange={event => setNote(event.target.value)} /></label><div className="admin-inline-actions"><button className="admin-row-action" type="button" onClick={() => setSelected(null)}>{t('common.cancel')}</button><button className="broadcast-primary" type="submit" disabled={reason.trim().length < 10}>{t('common.save')}</button></div></form></div>}</div>{dialog}</>
}
