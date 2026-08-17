'use client'

import { AlertTriangle, CheckCircle2, Siren } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAdminPrompt } from './AdminPromptDialog'
import { adminMutationHeaders } from '@/lib/admin/client'
import { useI18n } from '@/lib/i18n'

type Incident = { id: string; title: string; summary: string; service: string; severity: string; status: string; startedAt: string; resolvedAt: string | null }

export function AdminIncidentsPage({ canManage }: { canManage: boolean }) {
  const [items, setItems] = useState<Incident[]>([])
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [service, setService] = useState('web')
  const [severity, setSeverity] = useState('medium')
  const [notice, setNotice] = useState('')
  const { request, dialog } = useAdminPrompt()
  const { t } = useI18n()
  async function load() { const response = await fetch('/api/admin/v1/incidents', { cache: 'no-store' }); const payload = await response.json().catch(() => null) as { incidents?: Incident[]; error?: string } | null; setItems(payload?.incidents ?? []); if (!response.ok) setNotice(payload?.error ?? t('admin.incidents.unableLoad')) }
  useEffect(() => { void load() }, [])
  async function create(event: React.FormEvent<HTMLFormElement>) { event.preventDefault(); const reason = await request({ title: t('admin.incidents.create'), label: t('admin.incidents.reason'), kind: 'reason' }); if (!reason) return; const response = await fetch('/api/admin/v1/incidents', { method: 'POST', headers: adminMutationHeaders(), body: JSON.stringify({ title, summary, service, severity, reason }) }); const payload = await response.json().catch(() => null) as { error?: string } | null; setNotice(response.ok ? t('admin.incidents.created') : payload?.error ?? t('admin.incidents.unableCreate')); if (response.ok) { setTitle(''); setSummary(''); await load() } }
  async function update(id: string, status: string) { const reason = await request({ title: `${t('admin.incidents.setTo')} ${status}`, label: t('admin.incidents.changeReason'), kind: 'reason' }); if (!reason) return; const response = await fetch(`/api/admin/v1/incidents/${id}`, { method: 'PATCH', headers: adminMutationHeaders(), body: JSON.stringify({ status, reason }) }); const payload = await response.json().catch(() => null) as { error?: string } | null; setNotice(response.ok ? t('admin.incidents.updated') : payload?.error ?? t('admin.incidents.unableUpdate')); if (response.ok) await load() }
  return <><div className="admin-page"><header className="admin-header"><div><h1>{t('admin.incidents.title')}</h1><p>{t('admin.incidents.description')}</p></div><Siren size={22} aria-hidden="true" /></header><section className="admin-list-page">{notice && <div className="admin-alert">{notice}</div>}{canManage && <form className="admin-filter-panel" onSubmit={(event) => void create(event)}><label>{t('admin.incidents.titleLabel')}<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required /></label><label>{t('admin.incidents.service')}<input value={service} onChange={(event) => setService(event.target.value)} maxLength={80} required /></label><label>{t('admin.incidents.severity')}<select value={severity} onChange={(event) => setSeverity(event.target.value)}><option value="low">{t('admin.incidents.low')}</option><option value="medium">{t('admin.incidents.medium')}</option><option value="high">{t('admin.incidents.high')}</option><option value="critical">{t('admin.incidents.critical')}</option></select></label><label>{t('admin.incidents.summary')}<textarea value={summary} onChange={(event) => setSummary(event.target.value)} maxLength={2000} required /></label><button className="admin-primary-button" type="submit"><AlertTriangle size={15} /> {t('admin.incidents.create')}</button></form>}<div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>{t('admin.incidents.incident')}</th><th>{t('admin.incidents.service')}</th><th>{t('admin.incidents.severity')}</th><th>{t('admin.incidents.status')}</th><th>{t('admin.incidents.started')}</th><th aria-label={t('admin.incidents.actions')} /></tr></thead><tbody>{items.length === 0 ? <tr><td colSpan={6}>{t('admin.incidents.empty')}</td></tr> : items.map(item => <tr key={item.id}><td><strong>{item.title}</strong><small>{item.summary}</small></td><td>{item.service}</td><td>{item.severity}</td><td>{item.status}</td><td>{new Date(item.startedAt).toLocaleString()}</td><td>{canManage && item.status !== 'resolved' ? <span className="admin-action-group"><button className="admin-row-action" onClick={() => void update(item.id, 'monitoring')}>{t('admin.incidents.monitor')}</button><button className="admin-row-action" onClick={() => void update(item.id, 'resolved')}><CheckCircle2 size={14} /> {t('admin.incidents.resolve')}</button></span> : null}</td></tr>)}</tbody></table></div></section></div>{dialog}</>
}
