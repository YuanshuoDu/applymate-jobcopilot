'use client'

import React, { useEffect, useState } from 'react'
import { Card, Btn } from '@/components/ui'

type Subscription = { id: string; userId: string; plan: string; status: string; trialEndsAt: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; version: number; user: { name: string | null; email: string; plan: string } }

export function AdminSubscriptionControls({ canUpdate }: { canUpdate: boolean }) {
  const [items, setItems] = useState<Subscription[]>([])
  const [userId, setUserId] = useState('')
  const [plan, setPlan] = useState('pro')
  const [status, setStatus] = useState('trialing')
  const [trialEndsAt, setTrialEndsAt] = useState('')
  const [notice, setNotice] = useState('')

  async function load() {
    const response = await fetch('/api/admin/v1/plans/subscriptions?limit=50', { cache: 'no-store' })
    const payload = await response.json().catch(() => null) as { items?: Subscription[]; error?: string } | null
    setItems(payload?.items ?? [])
    if (!response.ok) setNotice(response.status >= 500 ? 'Subscription operations are unavailable until the production billing migrations are applied.' : payload?.error ?? 'Unable to load subscriptions.')
  }
  useEffect(() => { void load() }, [])
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!userId.trim()) return
    const response = await fetch('/api/admin/v1/plans/subscriptions', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ userId: userId.trim(), plan, status, trialEndsAt: status === 'trialing' ? new Date(trialEndsAt).toISOString() : null, reason: 'Updating a customer subscription after a reviewed billing decision' }) })
    const payload = await response.json().catch(() => null) as { error?: string } | null
    setNotice(response.ok ? 'Subscription updated.' : payload?.error ?? 'Unable to update subscription.')
    if (response.ok) { setUserId(''); setTrialEndsAt(''); await load() }
  }
  return <Card style={{ padding: 20, display: 'grid', gap: 16 }}><div><h2 style={{ margin: 0, fontSize: 16 }}>Subscription operations</h2><p style={{ margin: '6px 0 0', color: 'var(--text-muted)', fontSize: 12 }}>Start or end a trial, change a plan, and retain a versioned billing history.</p></div>{notice && <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>{notice}</div>}<form onSubmit={(event) => void save(event)} style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1.4fr) repeat(3, minmax(120px, 1fr)) auto', gap: 10, alignItems: 'end' }}><label style={labelStyle}>User ID<input required value={userId} onChange={(event) => setUserId(event.target.value)} style={inputStyle} /></label><label style={labelStyle}>Plan<select value={plan} onChange={(event) => setPlan(event.target.value)} style={inputStyle}><option value="free">Free</option><option value="pro">Pro</option><option value="enterprise">Enterprise</option></select></label><label style={labelStyle}>State<select value={status} onChange={(event) => setStatus(event.target.value)} style={inputStyle}><option value="trialing">Trialing</option><option value="active">Active</option><option value="past_due">Past due</option><option value="cancelled">Cancelled</option><option value="expired">Expired</option></select></label><label style={labelStyle}>Trial ends<input type="datetime-local" required={status === 'trialing'} value={trialEndsAt} onChange={(event) => setTrialEndsAt(event.target.value)} style={inputStyle} /></label><Btn variant="primary" disabled={!canUpdate}>Save</Btn></form><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>User</th><th>Plan</th><th>State</th><th>Trial end</th><th>Period end</th></tr></thead><tbody>{items.length === 0 ? <tr><td colSpan={5}>No subscription records.</td></tr> : items.map(item => <tr key={item.id}><td>{item.user.name ?? 'Unnamed'} · {item.user.email}</td><td>{item.plan}</td><td>{item.status}{item.cancelAtPeriodEnd ? ' · ending' : ''}</td><td>{item.trialEndsAt ? new Date(item.trialEndsAt).toLocaleString() : '—'}</td><td>{item.currentPeriodEnd ? new Date(item.currentPeriodEnd).toLocaleString() : '—'}</td></tr>)}</tbody></table></div></Card>
}

const labelStyle = { display: 'grid', gap: 6, color: 'var(--text-muted)', fontSize: 12 }
const inputStyle = { width: '100%', boxSizing: 'border-box' as const, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg)', color: 'var(--text)', font: 'inherit', fontSize: 12 }
