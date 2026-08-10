'use client'

import { BarChart3, Check, Megaphone, Send, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAdminPrompt } from './AdminPromptDialog'

type Broadcast = { id: string; title: string; body: string; audienceType: string; status: string; approvedById: string | null; scheduledAt: string | null; recipientCount: number; deliveredCount: number; failedCount: number; createdAt: string }
type Template = { id: string; name: string; title: string; body: string }
type Delivery = { id: string; userId: string; status: string; attempts: number; error: string | null; deliveredAt: string | null; updatedAt: string }
type AudienceType = 'all_active_users' | 'plan' | 'location'

export function AdminBroadcastsPage({ permissions }: { permissions: readonly string[] }) {
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
  async function load() {
    setLoading(true)
    const response = await fetch('/api/admin/v1/broadcasts', { cache: 'no-store' })
    const payload = await response.json().catch(() => null) as { items?: Broadcast[]; error?: string } | null
    setItems(payload?.items ?? [])
    if (!response.ok) setNotice(payload?.error ?? 'Unable to load broadcasts.')
    setLoading(false)
  }
  useEffect(() => { void load() }, [])
  useEffect(() => { if (permissions.includes('broadcasts.create')) void fetch('/api/admin/v1/broadcasts/templates', { cache: 'no-store' }).then(response => response.json()).then(payload => setTemplates(payload.templates ?? [])).catch(() => undefined) }, [permissions])

  async function request(url: string, payload: Record<string, unknown>) {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(payload) })
    const result = await response.json().catch(() => null) as { error?: string; recipientCount?: number } | null
    if (!response.ok) { setNotice(result?.error ?? 'Action failed.'); return null }
    return result
  }
  async function createDraft() {
    const audience = audienceType === 'all_active_users' ? {} : audienceType === 'plan' ? { plan: audienceValue || 'pro' } : { location: audienceValue }
    const result = await request('/api/admin/v1/broadcasts', { title, body, audienceType, audience, reason: 'Creating platform announcement draft' })
    if (result) { setTitle(''); setBody(''); setAudienceValue(''); setNotice('Draft created.'); await load() }
  }
  async function preview(id: string) {
    const result = await request(`/api/admin/v1/broadcasts/${id}/preview`, {})
    if (result) setNotice(`Anonymous audience preview: ${result.recipientCount ?? 0} recipients.`)
  }
  async function approve(id: string) {
    if (await request(`/api/admin/v1/broadcasts/${id}/approve`, { reason: 'Approving reviewed platform announcement' })) { setNotice('Broadcast approved.'); await load() }
  }
  async function publish(id: string) {
    if (await request(`/api/admin/v1/broadcasts/${id}/publish`, { confirmation: 'publish', reason: 'Publishing approved platform announcement' })) { setNotice('Broadcast published.'); await load() }
  }
  async function cancel(id: string) {
    if (await request(`/api/admin/v1/broadcasts/${id}/cancel`, { reason: 'Cancelling platform announcement draft' })) { setNotice('Broadcast cancelled.'); await load() }
  }
  async function schedule(id: string) {
    const value = await prompt({ title: 'Schedule broadcast', label: 'Publish at', kind: 'datetime', submitLabel: 'Schedule' })
    if (!value) return
    if (await request(`/api/admin/v1/broadcasts/${id}/schedule`, { scheduledAt: value, reason: 'Scheduling approved platform announcement for controlled delivery' })) { setNotice('Broadcast scheduled.'); await load() }
  }
  async function retry(id: string) {
    if (await request(`/api/admin/v1/broadcasts/${id}/retry`, { reason: 'Retrying failed platform announcement after delivery review' })) { setNotice('Broadcast returned to draft for review.'); await load() }
  }
  async function edit(id: string, current: Broadcast) {
    const nextTitle = await prompt({ title: 'Edit broadcast title', label: 'Title', kind: 'text', initialValue: current.title, submitLabel: 'Next' })
    if (!nextTitle) return
    const nextBody = await prompt({ title: 'Edit broadcast body', label: 'Message', kind: 'text', initialValue: current.body, submitLabel: 'Save' })
    if (!nextBody) return
    if (await request(`/api/admin/v1/broadcasts/${id}`, { title: nextTitle, body: nextBody, reason: 'Editing platform announcement before approval' })) { setNotice('Broadcast updated.'); await load() }
  }
  async function testSend(id: string) {
    if (await request(`/api/admin/v1/broadcasts/${id}/test`, { reason: 'Sending a controlled preview to the current administrator' })) setNotice('Test notification sent to your administrator inbox.')
  }
  async function showDeliveries(id: string) {
    const response = await fetch(`/api/admin/v1/broadcasts/${id}/deliveries`, { cache: 'no-store' })
    const payload = await response.json().catch(() => null) as { deliveries?: Delivery[]; error?: string } | null
    setDeliveryBroadcast(id)
    setDeliveries(payload?.deliveries ?? [])
    if (!response.ok) setNotice(payload?.error ?? 'Unable to load delivery details.')
  }
  async function saveTemplate() {
    const name = await prompt({ title: 'Save broadcast template', label: 'Template name', kind: 'text', submitLabel: 'Save' })
    if (!name || !title.trim() || !body.trim()) return
    const result = await request('/api/admin/v1/broadcasts/templates', { name, title, body, reason: 'Saving a reviewed broadcast template for future announcements' })
    if (result) { setNotice('Template saved.'); const response = await fetch('/api/admin/v1/broadcasts/templates', { cache: 'no-store' }); const payload = await response.json().catch(() => null) as { templates?: Template[] } | null; setTemplates(payload?.templates ?? []) }
  }

  return <><div className="admin-page"><header className="admin-header"><div><h1>Broadcasts</h1><p>In-app platform announcements</p></div><Megaphone size={22} aria-hidden="true" /></header>
    <section className="broadcast-layout"><form className="broadcast-compose" onSubmit={(event) => { event.preventDefault(); void createDraft() }}><h2>New draft</h2>{templates.length > 0 && <label>Template<select defaultValue="" onChange={(event) => { const template = templates.find(item => item.id === event.target.value); if (template) { setTitle(template.title); setBody(template.body) } }}><option value="">Start from scratch</option>{templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>}<label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required /></label><label>Message<textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={2000} required /></label><div className="broadcast-audience"><label>Audience<select value={audienceType} onChange={(event) => setAudienceType(event.target.value as AudienceType)}><option value="all_active_users">All active users</option><option value="plan">Plan</option><option value="location">Location</option></select></label>{audienceType === 'plan' && <label>Plan<select value={audienceValue} onChange={(event) => setAudienceValue(event.target.value)}><option value="pro">Pro</option><option value="free">Free</option><option value="enterprise">Enterprise</option></select></label>}{audienceType === 'location' && <label>Location<input value={audienceValue} onChange={(event) => setAudienceValue(event.target.value)} maxLength={80} required /></label>}</div><div className="admin-inline-actions"><button className="broadcast-primary" type="submit"><Send size={16} /> Create draft</button><button className="admin-secondary" type="button" disabled={!permissions.includes('broadcasts.update') || !title.trim() || !body.trim()} onClick={() => void saveTemplate()}>Save template</button></div></form>
      <section className="broadcast-list"><div className="broadcast-list-title"><h2>Announcements</h2>{notice && <span role="status">{notice}</span>}</div>{loading ? <p>Loading broadcasts...</p> : items.length === 0 ? <p>No broadcasts yet.</p> : items.map((item) => <article className="broadcast-row" key={item.id}><div><h3>{item.title}</h3><p>{item.body}</p><small>{item.audienceType.replaceAll('_', ' ')} · {item.scheduledAt ? `scheduled ${new Date(item.scheduledAt).toLocaleString()}` : item.approvedById ? 'Approved' : item.status} · {new Date(item.createdAt).toLocaleString()}</small><small>Delivery: {item.deliveredCount}/{item.recipientCount} delivered · {item.failedCount} failed</small>{item.recipientCount > 0 && <div className="admin-trend-bar" aria-label={`${item.deliveredCount} of ${item.recipientCount} delivered`}><i style={{ width: `${Math.min(100, Math.max(0, (item.deliveredCount / item.recipientCount) * 100))}%` }} /></div>}</div><div className="broadcast-actions"><button title="Preview anonymous audience" type="button" onClick={() => void preview(item.id)} disabled={!can('broadcasts.preview')}><BarChart3 size={16} /></button><button title="Send test notification to me" type="button" onClick={() => void testSend(item.id)} disabled={!can('broadcasts.preview')}>Test</button><button title="View delivery details" type="button" onClick={() => void showDeliveries(item.id)} disabled={!can('broadcasts.create')}>Details</button>{item.status === 'draft' && <button title="Edit draft" type="button" onClick={() => void edit(item.id, item)} disabled={!can('broadcasts.update')}>Edit</button>}{!item.approvedById && item.status === 'draft' && <button title="Approve broadcast" type="button" onClick={() => void approve(item.id)} disabled={!can('broadcasts.approve')}><Check size={16} /></button>}{item.approvedById && item.status === 'draft' && <><button title="Publish broadcast" type="button" onClick={() => void publish(item.id)} disabled={!can('broadcasts.publish')}><Send size={16} /></button><button title="Schedule broadcast" type="button" onClick={() => void schedule(item.id)} disabled={!can('broadcasts.schedule')}>Schedule</button></>}{item.status === 'failed' && <button title="Retry failed broadcast" type="button" onClick={() => void retry(item.id)} disabled={!can('broadcasts.publish')}>Retry</button>}{['draft', 'scheduled'].includes(item.status) && <button title="Cancel broadcast" type="button" onClick={() => void cancel(item.id)} disabled={!can('broadcasts.cancel')}><X size={16} /></button>}</div></article>)}{deliveryBroadcast && <section className="admin-subsection"><h2>Delivery details</h2><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>User ID</th><th>Status</th><th>Attempts</th><th>Error</th><th>Updated</th></tr></thead><tbody>{deliveries.length === 0 ? <tr><td colSpan={5}>No delivery records.</td></tr> : deliveries.map(delivery => <tr key={delivery.id}><td>{delivery.userId}</td><td>{delivery.status}</td><td>{delivery.attempts}</td><td>{delivery.error ?? '—'}</td><td>{new Date(delivery.updatedAt).toLocaleString()}</td></tr>)}</tbody></table></div></section>}</section>
    </section>
  </div>{dialog}</>
}
