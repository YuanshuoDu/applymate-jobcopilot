'use client'

import { RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAdminPrompt } from './AdminPromptDialog'
import { adminMutationHeaders } from '@/lib/admin/client'

type DeletionRequest = { id: string; status: string; reason: string | null; requestedAt: string; processedAt: string | null; version: number; user: { name: string | null; email: string; plan: string; accountStatus: string } | null }
type RetentionPolicy = { key: string; name: string; retentionDays: number; enabled: boolean; version: number }

export function AdminDeletionQueuePage() {
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

  async function load() {
    setLoading(true)
    const response = await fetch(`/api/admin/v1/users/deletions?limit=100${status ? `&status=${encodeURIComponent(status)}` : ''}`, { cache: 'no-store' })
    const payload = await response.json().catch(() => null) as { items?: DeletionRequest[]; error?: string } | null
    setItems(payload?.items ?? [])
    setSelectedIds(current => current.filter(id => (payload?.items ?? []).some(item => item.id === id)))
    if (!response.ok) setNotice(payload?.error ?? 'Unable to load deletion requests.')
    setLoading(false)
  }
  useEffect(() => { void load() }, [status])
  useEffect(() => { void fetch('/api/admin/v1/users/deletions/retention', { cache: 'no-store' }).then(response => response.json()).then(payload => { if (payload.policy) { setRetention(payload.policy); setRetentionDays(String(payload.policy.retentionDays)); setRetentionEnabled(payload.policy.enabled) } }).catch(() => undefined) }, [])

  async function saveRetention() {
    const confirmation = await request({ title: 'Save data retention policy', label: 'Reason', kind: 'reason', description: 'This controls how long completed deletion queue tombstones remain available for audit operations.', submitLabel: 'Save policy' })
    if (!confirmation || !retention) return
      const response = await fetch('/api/admin/v1/users/deletions/retention', { method: 'PATCH', headers: adminMutationHeaders(), body: JSON.stringify({ key: retention.key, retentionDays: Number(retentionDays), enabled: retentionEnabled, version: retention.version, reason: confirmation }) })
    const payload = await response.json().catch(() => null) as { policy?: RetentionPolicy; error?: string } | null
    if (response.ok && payload?.policy) { setRetention(payload.policy); setRetentionDays(String(payload.policy.retentionDays)); setRetentionEnabled(payload.policy.enabled); setNotice('Retention policy saved.') }
    else setNotice(payload?.error ?? 'Unable to save retention policy.')
  }

  async function update(event: React.FormEvent) {
    event.preventDefault()
    if (!selected || reason.trim().length < 10) return
      const response = await fetch(`/api/admin/v1/users/deletions/${selected.id}`, { method: 'PATCH', headers: adminMutationHeaders(), body: JSON.stringify({ status: nextStatus, version: selected.version, reason: reason.trim(), note: note.trim() }) })
    const payload = await response.json().catch(() => null) as { error?: string } | null
    setNotice(response.ok ? 'Deletion request updated.' : payload?.error ?? 'Unable to update deletion request.')
    if (response.ok) { setSelected(null); setReason(''); setNote(''); await load() }
  }

  async function bulkAdvance() {
    const targets = items.filter(item => selectedIds.includes(item.id) && ['requested', 'processing'].includes(item.status))
    if (!targets.length) return
    const confirmation = await request({ title: 'Advance selected deletion requests', label: 'Reason', kind: 'reason', description: `This will advance ${targets.length} request${targets.length === 1 ? '' : 's'} to the next controlled state.`, submitLabel: 'Advance requests' })
    if (!confirmation) return
    let completed = 0
    for (const item of targets) {
      const next = item.status === 'requested' ? 'processing' : 'completed'
      const response = await fetch(`/api/admin/v1/users/deletions/${item.id}`, { method: 'PATCH', headers: adminMutationHeaders(), body: JSON.stringify({ status: next, version: item.version, reason: confirmation, note: 'Bulk queue operation' }) })
      if (response.ok) completed += 1
    }
    setNotice(`${completed}/${targets.length} deletion requests advanced.`)
    setSelectedIds([])
    await load()
  }

  return <><div className="admin-page"><header className="admin-header"><div><h1>Data deletion queue</h1><p>Process GDPR deletion requests with a versioned audit trail</p></div><Trash2 size={22} aria-hidden="true" /></header><section className="admin-list-page"><div className="admin-queue-title"><span role="status">{notice}</span><div className="admin-inline-actions"><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All states</option><option value="requested">Requested</option><option value="processing">Processing</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select><button className="admin-secondary" type="button" disabled={!selectedIds.length} onClick={() => void bulkAdvance()}>Advance selected ({selectedIds.length})</button><button className="admin-row-action" type="button" title="Refresh deletion queue" onClick={() => void load()}><RefreshCw size={16} /></button></div></div>{retention && <section className="admin-retention-card"><div><h2>Deletion retention</h2><p>Completed queue tombstones contain operational metadata only and are purged automatically after this period.</p></div><div className="admin-inline-actions"><label>Days<input type="number" min={1} max={3650} value={retentionDays} onChange={event => setRetentionDays(event.target.value)} /></label><label className="admin-operation-checkbox"><input type="checkbox" checked={retentionEnabled} onChange={event => setRetentionEnabled(event.target.checked)} /> Enabled</label><button className="admin-secondary" type="button" onClick={() => void saveRetention()}>Save policy</button></div></section>}<div className="admin-table-wrap"><table className="admin-table"><thead><tr><th><span className="sr-only">Select</span></th><th>User</th><th>Plan</th><th>State</th><th>Requested</th><th>Processed</th><th aria-label="Actions" /></tr></thead><tbody>{loading ? <tr><td colSpan={7}>Loading…</td></tr> : items.length === 0 ? <tr><td colSpan={7}>No deletion requests.</td></tr> : items.map((item) => { const selectable = ['requested', 'processing'].includes(item.status) && Boolean(item.user); return <tr key={item.id}><td><input type="checkbox" aria-label={`Select deletion request for ${item.user?.email ?? 'deleted account'}`} disabled={!selectable} checked={selectedIds.includes(item.id)} onChange={(event) => setSelectedIds(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} /></td><td>{item.user ? `${item.user.name ?? 'Unnamed'} · ${item.user.email}` : 'Deleted account (tombstone)'}</td><td>{item.user?.plan ?? '—'}</td><td>{item.status}</td><td>{new Date(item.requestedAt).toLocaleString()}</td><td>{item.processedAt ? new Date(item.processedAt).toLocaleString() : '—'}</td><td>{item.status === 'requested' && item.user && <button className="admin-row-action" type="button" onClick={() => { setSelected(item); setNextStatus('processing') }}>Start</button>}{item.status === 'processing' && item.user && <button className="admin-row-action" type="button" onClick={() => { setSelected(item); setNextStatus('completed') }}>Complete</button>}</td></tr> })}</tbody></table></div></section>{selected && <div className="security-dialog-backdrop"><form className="security-card security-dialog" role="dialog" aria-modal="true" onSubmit={(event) => void update(event)}><h2>{nextStatus === 'completed' ? 'Complete deletion request' : 'Start deletion processing'}</h2><p>{selected.user?.email ?? 'This account'} · this action is audited and cannot be undone after completion.</p><label>Reason<textarea required minLength={10} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} autoFocus /></label><label>Processing note<textarea maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} /></label><div className="admin-inline-actions"><button className="admin-row-action" type="button" onClick={() => setSelected(null)}>Cancel</button><button className="broadcast-primary" type="submit" disabled={reason.trim().length < 10}>Save</button></div></form></div>}</div>{dialog}</>
}
