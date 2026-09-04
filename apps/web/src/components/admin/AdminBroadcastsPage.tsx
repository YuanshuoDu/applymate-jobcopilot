'use client'

import { BarChart3, Check, RefreshCw, Send, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useAdminPrompt } from './AdminPromptDialog'
import { adminMutationHeaders } from '@/lib/admin/client'
import { useI18n } from '@/lib/i18n'

type Audience = { plan?: string; location?: string; userIds?: string[] }
type Broadcast = { id: string; title: string; body: string; audienceType: string; audience: Audience; status: string; createdById: string; approvedById: string | null; scheduledAt: string | null; recipientCount: number; deliveredCount: number; failedCount: number; createdAt: string }
type Template = { id: string; name: string; title: string; body: string }
type Delivery = { id: string; userId: string; status: string; attempts: number; error: string | null; deliveredAt: string | null; updatedAt: string }
type AudienceType = 'all_active_users' | 'plan' | 'location'
type ActionPayload = { error?: string; recipientCount?: number }

function audienceLabel(item: Pick<Broadcast, 'audienceType' | 'audience'>, t: (key: string) => string) {
  if (item.audienceType === 'all_active_users') return t('broadcasts.allActive')
  if (item.audienceType === 'plan') return `${item.audience.plan ?? t('broadcasts.unknown')} ${t('broadcasts.plan')}`
  if (item.audienceType === 'location') return `${t('broadcasts.location')}: ${item.audience.location ?? t('broadcasts.unknown')}`
  return `${item.audience.userIds?.length ?? 0} ${t('broadcasts.selectedAccounts')}`
}

export function AdminBroadcastsPage({ actorId, permissions }: { actorId: string; permissions: readonly string[] }) {
  const { t } = useI18n()
  const { request: prompt, dialog } = useAdminPrompt()
  const [items, setItems] = useState<Broadcast[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [deliveryBroadcast, setDeliveryBroadcast] = useState('')
  const [title, setTitle] = useState(''); const [body, setBody] = useState(''); const [reason, setReason] = useState('')
  const [audienceType, setAudienceType] = useState<AudienceType>('all_active_users'); const [audienceValue, setAudienceValue] = useState('')
  const [notice, setNotice] = useState(''); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false)
  const can = (permission: string) => permissions.includes(permission)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/admin/v1/broadcasts', { cache: 'no-store' })
      const payload = await response.json().catch(() => null) as { items?: Broadcast[]; error?: string } | null
      if (!response.ok) throw new Error(payload?.error ?? t('broadcastAdmin.loadFailed'))
      setItems(payload?.items ?? []); setNotice('')
    } catch (error) { setNotice(error instanceof Error ? error.message : t('broadcastAdmin.loadFailed')) } finally { setLoading(false) }
  }, [t])

  useEffect(() => { void load() }, [load])
  useEffect(() => { if (!permissions.includes('broadcasts.create')) return; void fetch('/api/admin/v1/broadcasts/templates', { cache: 'no-store' }).then(response => response.json()).then(payload => setTemplates(payload.templates ?? [])).catch(() => undefined) }, [permissions])

  async function request(url: string, payload: Record<string, unknown>) {
    setBusy(true)
    try {
      const response = await fetch(url, { method: 'POST', headers: adminMutationHeaders(), body: JSON.stringify(payload) })
      const result = await response.json().catch(() => null) as ActionPayload | null
      if (!response.ok) { setNotice(result?.error ?? t('broadcastAdmin.actionFailed')); return null }
      return result ?? {}
    } catch { setNotice(t('broadcastAdmin.actionFailed')); return null } finally { setBusy(false) }
  }

  async function createDraft() {
    const audience = audienceType === 'all_active_users' ? {} : audienceType === 'plan' ? { plan: audienceValue || 'pro' } : { location: audienceValue.trim() }
    if (!title.trim() || !body.trim() || reason.trim().length < 10 || (audienceType === 'location' && !audienceValue.trim())) return
    if (await request('/api/admin/v1/broadcasts', { title, body, audienceType, audience, reason })) { setTitle(''); setBody(''); setReason(''); setAudienceValue(''); setNotice(t('broadcastAdmin.draftCreated')); await load() }
  }

  async function lifecycleAction(id: string, action: 'submit' | 'approve' | 'publish' | 'cancel' | 'retry') {
    const labels = { submit: t('broadcasts.submitApproval'), approve: t('broadcasts.approve'), publish: t('broadcasts.publish'), cancel: t('broadcasts.cancel'), retry: t('broadcasts.retry') }
    const value = await prompt({ title: labels[action], label: t('broadcasts.reasonPrompt'), kind: 'reason', submitLabel: t('common.continue') })
    if (!value || (action === 'publish' && !window.confirm(t('broadcasts.publishConfirm')))) return
    const payload = { reason: value, ...(action === 'publish' ? { confirmation: 'publish' } : {}) }
    if (await request(`/api/admin/v1/broadcasts/${id}/${action}`, payload)) { setNotice(`${labels[action]} ✓`); await load() }
  }

  async function schedule(id: string) {
    const value = await prompt({ title: t('broadcastAdmin.schedule'), label: t('broadcastAdmin.publishAt'), kind: 'datetime', submitLabel: t('broadcastAdmin.schedule') })
    if (!value) return
    if (await request(`/api/admin/v1/broadcasts/${id}/schedule`, { scheduledAt: value, reason: 'Scheduling the approved platform announcement for controlled delivery' })) { setNotice(t('broadcastAdmin.scheduled')); await load() }
  }

  async function edit(id: string, current: Broadcast) {
    const nextTitle = await prompt({ title: t('broadcastAdmin.editTitle'), label: t('broadcastAdmin.titleLabel'), kind: 'text', initialValue: current.title, submitLabel: t('broadcastAdmin.next') })
    if (!nextTitle) return
    const nextBody = await prompt({ title: t('broadcastAdmin.editBody'), label: t('broadcastAdmin.message'), kind: 'text', initialValue: current.body, submitLabel: t('common.save') })
    if (nextBody && await request(`/api/admin/v1/broadcasts/${id}`, { title: nextTitle, body: nextBody, reason: 'Editing the platform announcement before approval' })) { setNotice(t('broadcastAdmin.updated')); await load() }
  }

  async function preview(id: string) { const result = await request(`/api/admin/v1/broadcasts/${id}/preview`, {}); if (result) setNotice(`${t('broadcastAdmin.audiencePreview')}: ${result.recipientCount ?? 0} ${t('broadcastAdmin.recipients')}.`) }
  async function testSend(id: string) { if (await request(`/api/admin/v1/broadcasts/${id}/test`, { reason: 'Sending a controlled preview to the current administrator' })) setNotice(t('broadcastAdmin.testSent')) }
  async function showDeliveries(id: string) { try { const response = await fetch(`/api/admin/v1/broadcasts/${id}/deliveries`, { cache: 'no-store' }); const payload = await response.json().catch(() => null) as { deliveries?: Delivery[]; error?: string } | null; if (!response.ok) throw new Error(payload?.error ?? t('broadcastAdmin.deliveryLoadFailed')); setDeliveryBroadcast(id); setDeliveries(payload?.deliveries ?? []) } catch (error) { setNotice(error instanceof Error ? error.message : t('broadcastAdmin.deliveryLoadFailed')) } }

  return <><div className="admin-page"><header className="admin-header"><div><h1>{t('broadcasts.title')}</h1><p>{t('broadcasts.description')}</p></div><button className="admin-secondary" type="button" onClick={() => void load()} disabled={loading}><RefreshCw size={15} /> {t('common.refresh')}</button></header>{notice && <div className="admin-operation-status" role="status">{notice}</div>}
    <section className="broadcast-layout">{can('broadcasts.create') ? <form className="broadcast-compose" onSubmit={event => { event.preventDefault(); void createDraft() }}><h2>{t('broadcasts.newDraft')}</h2>{templates.length > 0 && <label>{t('broadcasts.template')}<select value="" onChange={event => { const template = templates.find(item => item.id === event.target.value); if (template) { setTitle(template.title); setBody(template.body) } }}><option value="">{t('broadcasts.startFromScratch')}</option>{templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>}<label>{t('broadcasts.titleLabel')}<input value={title} onChange={event => setTitle(event.target.value)} maxLength={120} required /></label><label>{t('broadcasts.message')}<textarea value={body} onChange={event => setBody(event.target.value)} maxLength={2000} required /></label><div className="broadcast-audience"><label>{t('broadcasts.audience')}<select value={audienceType} onChange={event => setAudienceType(event.target.value as AudienceType)}><option value="all_active_users">{t('broadcasts.allActive')}</option><option value="plan">{t('broadcasts.plan')}</option><option value="location">{t('broadcasts.location')}</option></select></label>{audienceType === 'plan' && <label>{t('broadcasts.plan')}<select value={audienceValue} onChange={event => setAudienceValue(event.target.value)}><option value="pro">{t('admin.pro')}</option><option value="free">{t('admin.free')}</option><option value="enterprise">{t('admin.enterprise')}</option></select></label>}{audienceType === 'location' && <label>{t('broadcasts.location')}<input value={audienceValue} onChange={event => setAudienceValue(event.target.value)} maxLength={80} required /></label>}</div><label>{t('broadcasts.auditReason')}<textarea value={reason} onChange={event => setReason(event.target.value)} minLength={10} maxLength={500} required placeholder={t('broadcasts.auditReason')} /></label><button className="broadcast-primary" type="submit" disabled={busy || reason.trim().length < 10}><Send size={16} /> {t('broadcasts.createDraft')}</button></form> : <section className="broadcast-compose"><h2>{t('broadcastAdmin.approvalAccess')}</h2><p>{t('broadcastAdmin.approvalAccessDescription')}</p></section>}
      <section className="broadcast-list"><div className="broadcast-list-title"><h2>{t('broadcasts.announcements')}</h2><span>{items.length}</span></div>{loading ? <p>{t('broadcasts.loading')}</p> : items.length === 0 ? <p>{t('broadcasts.empty')}</p> : items.map(item => <article className="broadcast-row" key={item.id}><div><h3>{item.title}</h3><p>{item.body}</p><small>{audienceLabel(item, t)} · {item.scheduledAt ? `${t('broadcasts.scheduled')} ${new Date(item.scheduledAt).toLocaleString()}` : item.approvedById ? t('broadcasts.approved') : t(`broadcasts.status.${item.status}`)} · {new Date(item.createdAt).toLocaleString()}</small><small>{t('broadcasts.delivery')}: {item.deliveredCount}/{item.recipientCount} {t('broadcasts.delivered')} · {item.failedCount} {t('broadcasts.failed')}</small></div><div className="broadcast-actions"><button title={t('broadcasts.preview')} aria-label={t('broadcasts.preview')} type="button" onClick={() => void preview(item.id)} disabled={busy || !can('broadcasts.preview')}><BarChart3 size={16} /></button><button title={t('broadcasts.test')} type="button" onClick={() => void testSend(item.id)} disabled={busy || !can('broadcasts.preview')}>{t('broadcasts.test')}</button><button title={t('broadcasts.details')} type="button" onClick={() => void showDeliveries(item.id)} disabled={busy || !can('broadcasts.create')}>{t('broadcasts.details')}</button>{item.status === 'draft' && !item.approvedById && item.createdById === actorId && <button type="button" onClick={() => void lifecycleAction(item.id, 'submit')} disabled={busy || !can('broadcasts.update')}>{t('broadcasts.submitApproval')}</button>}{item.status === 'pending_approval' && item.createdById !== actorId && <button type="button" onClick={() => void lifecycleAction(item.id, 'approve')} disabled={busy || !can('broadcasts.approve')}><Check size={16} /> {t('broadcasts.approve')}</button>}{item.status === 'pending_approval' && item.createdById === actorId && <span className="broadcast-waiting">{t('broadcastAdmin.awaitingApproval')}</span>}{item.status === 'draft' && item.approvedById && <><button title={t('broadcasts.publish')} type="button" onClick={() => void lifecycleAction(item.id, 'publish')} disabled={busy || !can('broadcasts.publish')}><Send size={16} /> {t('broadcasts.publish')}</button><button type="button" onClick={() => void schedule(item.id)} disabled={busy || !can('broadcasts.schedule')}>{t('broadcasts.schedule')}</button></>}{item.status === 'failed' && <button type="button" onClick={() => void lifecycleAction(item.id, 'retry')} disabled={busy || !can('broadcasts.retry')}>{t('broadcasts.retry')}</button>}{['draft', 'pending_approval', 'scheduled'].includes(item.status) && <button title={t('broadcasts.cancel')} type="button" onClick={() => window.confirm(t('broadcasts.cancelConfirm')) && void lifecycleAction(item.id, 'cancel')} disabled={busy || !can('broadcasts.cancel')}><X size={16} /></button>}</div></article>)}{deliveryBroadcast && <section className="admin-subsection"><h2>{t('broadcasts.deliveryDetails')}</h2><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>{t('broadcasts.userId')}</th><th>{t('broadcasts.status')}</th><th>{t('broadcasts.attempts')}</th><th>{t('broadcasts.error')}</th><th>{t('broadcasts.updated')}</th></tr></thead><tbody>{deliveries.length === 0 ? <tr><td colSpan={5}>{t('broadcasts.noDeliveryRecords')}</td></tr> : deliveries.map(delivery => <tr key={delivery.id}><td>{delivery.userId}</td><td>{t(`broadcasts.status.${delivery.status}`)}</td><td>{delivery.attempts}</td><td>{delivery.error ?? '—'}</td><td>{new Date(delivery.updatedAt).toLocaleString()}</td></tr>)}</tbody></table></div></section>}</section>
    </section>
  </div>{dialog}</>
}
