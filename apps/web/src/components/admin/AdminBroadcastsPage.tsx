'use client'

import { BarChart3, Check, Megaphone, Send, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAdminPrompt } from './AdminPromptDialog'
import { adminMutationHeaders } from '@/lib/admin/client'
import { useI18n } from '@/lib/i18n'

type Broadcast = { id: string; title: string; body: string; audienceType: string; status: string; approvedById: string | null; scheduledAt: string | null; recipientCount: number; deliveredCount: number; failedCount: number; createdAt: string }
type Template = { id: string; name: string; title: string; body: string }
type Delivery = { id: string; userId: string; status: string; attempts: number; error: string | null; deliveredAt: string | null; updatedAt: string }
type AudienceType = 'all_active_users' | 'plan' | 'location'

export function AdminBroadcastsPage({ permissions }: { permissions: readonly string[] }) {
  const { t } = useI18n()
  const [items, setItems] = useState<Broadcast[]>([])
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [audienceType, setAudienceType] = useState<AudienceType>('all_active_users')
  const [audienceValue, setAudienceValue] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [templates, setTemplates] = useState<Template[]>([])
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [deliveryBroadcast, setDeliveryBroadcast] = useState('')
  const { request: prompt, dialog } = useAdminPrompt()

  const can = (permission: string) => permissions.includes(permission)
  const audienceLabel = (value: string) => value === 'all_active_users' ? t('broadcasts.allActive') : value === 'plan' ? t('broadcasts.plan') : value === 'location' ? t('broadcasts.location') : value
  const statusLabel = (value: string) => t(`broadcasts.status.${value}`)
  async function load() {
    setLoading(true)
    const response = await fetch('/api/admin/v1/broadcasts', { cache: 'no-store' })
    const payload = await response.json().catch(() => null) as { items?: Broadcast[]; error?: string } | null
    setItems(payload?.items ?? [])
    if (!response.ok) setNotice(payload?.error ?? t('broadcastAdmin.loadFailed'))
    setLoading(false)
  }
  useEffect(() => { void load() }, [])
  useEffect(() => { if (permissions.includes('broadcasts.create')) void fetch('/api/admin/v1/broadcasts/templates', { cache: 'no-store' }).then(response => response.json()).then(payload => setTemplates(payload.templates ?? [])).catch(() => undefined) }, [permissions])

  async function request(url: string, payload: Record<string, unknown>) {
    const response = await fetch(url, { method: 'POST', headers: adminMutationHeaders(), body: JSON.stringify(payload) })
    const result = await response.json().catch(() => null) as { error?: string; recipientCount?: number } | null
    if (!response.ok) { setNotice(result?.error ?? t('broadcastAdmin.actionFailed')); return null }
    return result
  }
  async function createDraft() {
    const audience = audienceType === 'all_active_users' ? {} : audienceType === 'plan' ? { plan: audienceValue || 'pro' } : { location: audienceValue }
    const result = await request('/api/admin/v1/broadcasts', { title, body, audienceType, audience, reason: 'Creating platform announcement draft' })
    if (result) { setTitle(''); setBody(''); setAudienceValue(''); setNotice(t('broadcastAdmin.draftCreated')); await load() }
  }
  async function preview(id: string) {
    const result = await request(`/api/admin/v1/broadcasts/${id}/preview`, {})
    if (result) setNotice(`${t('broadcastAdmin.audiencePreview')}: ${result.recipientCount ?? 0} ${t('broadcastAdmin.recipients')}.`)
  }
  async function approve(id: string) {
    if (await request(`/api/admin/v1/broadcasts/${id}/approve`, { reason: 'Approving reviewed platform announcement' })) { setNotice(t('broadcastAdmin.approved')); await load() }
  }
  async function publish(id: string) {
    if (await request(`/api/admin/v1/broadcasts/${id}/publish`, { confirmation: 'publish', reason: 'Publishing approved platform announcement' })) { setNotice(t('broadcastAdmin.published')); await load() }
  }
  async function cancel(id: string) {
    if (await request(`/api/admin/v1/broadcasts/${id}/cancel`, { reason: 'Cancelling platform announcement draft' })) { setNotice(t('broadcastAdmin.cancelled')); await load() }
  }
  async function schedule(id: string) {
    const value = await prompt({ title: t('broadcastAdmin.schedule'), label: t('broadcastAdmin.publishAt'), kind: 'datetime', submitLabel: t('broadcastAdmin.schedule') })
    if (!value) return
    if (await request(`/api/admin/v1/broadcasts/${id}/schedule`, { scheduledAt: value, reason: 'Scheduling approved platform announcement for controlled delivery' })) { setNotice(t('broadcastAdmin.scheduled')); await load() }
  }
  async function retry(id: string) {
    if (await request(`/api/admin/v1/broadcasts/${id}/retry`, { reason: 'Retrying failed platform announcement after delivery review' })) { setNotice(t('broadcastAdmin.retryDraft')); await load() }
  }
  async function edit(id: string, current: Broadcast) {
    const nextTitle = await prompt({ title: t('broadcastAdmin.editTitle'), label: t('broadcastAdmin.titleLabel'), kind: 'text', initialValue: current.title, submitLabel: t('broadcastAdmin.next') })
    if (!nextTitle) return
    const nextBody = await prompt({ title: t('broadcastAdmin.editBody'), label: t('broadcastAdmin.message'), kind: 'text', initialValue: current.body, submitLabel: t('common.save') })
    if (!nextBody) return
    if (await request(`/api/admin/v1/broadcasts/${id}`, { title: nextTitle, body: nextBody, reason: 'Editing platform announcement before approval' })) { setNotice(t('broadcastAdmin.updated')); await load() }
  }
  async function testSend(id: string) {
    if (await request(`/api/admin/v1/broadcasts/${id}/test`, { reason: 'Sending a controlled preview to the current administrator' })) setNotice(t('broadcastAdmin.testSent'))
  }
  async function showDeliveries(id: string) {
    const response = await fetch(`/api/admin/v1/broadcasts/${id}/deliveries`, { cache: 'no-store' })
    const payload = await response.json().catch(() => null) as { deliveries?: Delivery[]; error?: string } | null
    setDeliveryBroadcast(id)
    setDeliveries(payload?.deliveries ?? [])
    if (!response.ok) setNotice(payload?.error ?? t('broadcastAdmin.deliveryLoadFailed'))
  }
  async function saveTemplate() {
    const name = await prompt({ title: t('broadcastAdmin.saveTemplate'), label: t('broadcastAdmin.templateName'), kind: 'text', submitLabel: t('common.save') })
    if (!name || !title.trim() || !body.trim()) return
    const result = await request('/api/admin/v1/broadcasts/templates', { name, title, body, reason: 'Saving a reviewed broadcast template for future announcements' })
    if (result) { setNotice(t('broadcastAdmin.templateSaved')); const response = await fetch('/api/admin/v1/broadcasts/templates', { cache: 'no-store' }); const payload = await response.json().catch(() => null) as { templates?: Template[] } | null; setTemplates(payload?.templates ?? []) }
  }

  return <><div className="admin-page"><header className="admin-header"><div><h1>{t('broadcasts.title')}</h1><p>{t('broadcasts.description')}</p></div><Megaphone size={22} aria-hidden="true" /></header>
    <section className="broadcast-layout"><form className="broadcast-compose" onSubmit={(event) => { event.preventDefault(); void createDraft() }}><h2>{t('broadcasts.newDraft')}</h2>{templates.length > 0 && <label>{t('broadcasts.template')}<select defaultValue="" onChange={(event) => { const template = templates.find(item => item.id === event.target.value); if (template) { setTitle(template.title); setBody(template.body) } }}><option value="">{t('broadcasts.startFromScratch')}</option>{templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>}<label>{t('broadcasts.titleLabel')}<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required /></label><label>{t('broadcasts.message')}<textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={2000} required /></label><div className="broadcast-audience"><label>{t('broadcasts.audience')}<select value={audienceType} onChange={(event) => setAudienceType(event.target.value as AudienceType)}><option value="all_active_users">{t('broadcasts.allActive')}</option><option value="plan">{t('broadcasts.plan')}</option><option value="location">{t('broadcasts.location')}</option></select></label>{audienceType === 'plan' && <label>{t('broadcasts.plan')}<select value={audienceValue} onChange={(event) => setAudienceValue(event.target.value)}><option value="pro">{t('admin.pro')}</option><option value="free">{t('admin.free')}</option><option value="enterprise">{t('admin.enterprise')}</option></select></label>}{audienceType === 'location' && <label>{t('broadcasts.location')}<input value={audienceValue} onChange={(event) => setAudienceValue(event.target.value)} maxLength={80} required /></label>}</div><div className="admin-inline-actions"><button className="broadcast-primary" type="submit"><Send size={16} /> {t('broadcasts.createDraft')}</button><button className="admin-secondary" type="button" disabled={!permissions.includes('broadcasts.update') || !title.trim() || !body.trim()} onClick={() => void saveTemplate()}>{t('broadcasts.saveTemplate')}</button></div></form>
      <section className="broadcast-list"><div className="broadcast-list-title"><h2>{t('broadcasts.announcements')}</h2>{notice && <span role="status">{notice}</span>}</div>{loading ? <p>{t('broadcasts.loading')}</p> : items.length === 0 ? <p>{t('broadcasts.empty')}</p> : items.map((item) => <article className="broadcast-row" key={item.id}><div><h3>{item.title}</h3><p>{item.body}</p><small>{audienceLabel(item.audienceType)} · {item.scheduledAt ? `${t('broadcasts.scheduled')} ${new Date(item.scheduledAt).toLocaleString()}` : item.approvedById ? t('broadcasts.approved') : statusLabel(item.status)} · {new Date(item.createdAt).toLocaleString()}</small><small>{t('broadcasts.delivery')}: {item.deliveredCount}/{item.recipientCount} {t('broadcasts.delivered')} · {item.failedCount} {t('broadcasts.failed')}</small>{item.recipientCount > 0 && <div className="admin-trend-bar" aria-label={`${item.deliveredCount} ${t('broadcasts.of')} ${item.recipientCount} ${t('broadcasts.delivered')}`}><i style={{ width: `${Math.min(100, Math.max(0, (item.deliveredCount / item.recipientCount) * 100))}%` }} /></div>}</div><div className="broadcast-actions"><button title={t('broadcasts.preview')} type="button" onClick={() => void preview(item.id)} disabled={!can('broadcasts.preview')}><BarChart3 size={16} /></button><button title={t('broadcasts.test')} type="button" onClick={() => void testSend(item.id)} disabled={!can('broadcasts.preview')}>{t('broadcasts.test')}</button><button title={t('broadcasts.details')} type="button" onClick={() => void showDeliveries(item.id)} disabled={!can('broadcasts.create')}>{t('broadcasts.details')}</button>{item.status === 'draft' && <button title={t('broadcasts.edit')} type="button" onClick={() => void edit(item.id, item)} disabled={!can('broadcasts.update')}>{t('broadcasts.edit')}</button>}{!item.approvedById && item.status === 'draft' && <button title={t('broadcasts.approve')} type="button" onClick={() => void approve(item.id)} disabled={!can('broadcasts.approve')}><Check size={16} /></button>}{item.approvedById && item.status === 'draft' && <><button title={t('broadcasts.publish')} type="button" onClick={() => void publish(item.id)} disabled={!can('broadcasts.publish')}><Send size={16} /></button><button title={t('broadcasts.schedule')} type="button" onClick={() => void schedule(item.id)} disabled={!can('broadcasts.schedule')}>{t('broadcasts.schedule')}</button></>}{item.status === 'failed' && <button title={t('broadcasts.retry')} type="button" onClick={() => void retry(item.id)} disabled={!can('broadcasts.publish')}>{t('broadcasts.retry')}</button>}{['draft', 'scheduled'].includes(item.status) && <button title={t('broadcasts.cancel')} type="button" onClick={() => void cancel(item.id)} disabled={!can('broadcasts.cancel')}><X size={16} /></button>}</div></article>)}{deliveryBroadcast && <section className="admin-subsection"><h2>{t('broadcasts.deliveryDetails')}</h2><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>{t('broadcasts.userId')}</th><th>{t('broadcasts.status')}</th><th>{t('broadcasts.attempts')}</th><th>{t('broadcasts.error')}</th><th>{t('broadcasts.updated')}</th></tr></thead><tbody>{deliveries.length === 0 ? <tr><td colSpan={5}>{t('broadcasts.noDeliveryRecords')}</td></tr> : deliveries.map(delivery => <tr key={delivery.id}><td>{delivery.userId}</td><td>{statusLabel(delivery.status)}</td><td>{delivery.attempts}</td><td>{delivery.error ?? '—'}</td><td>{new Date(delivery.updatedAt).toLocaleString()}</td></tr>)}</tbody></table></div></section>}</section>
    </section>
  </div>{dialog}</>
}
