'use client'

import React, { useEffect, useState } from 'react'
import { Card, Btn } from '@/components/ui'
import { fetchWithTimeout } from '@/lib/hooks'
import { adminMutationHeaders } from '@/lib/admin/client'
import { useI18n } from '@/lib/i18n'

type Subscription = { id: string; userId: string; plan: string; status: string; trialEndsAt: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; version: number; user: { name: string | null; email: string; plan: string } }

export function AdminSubscriptionControls({ canUpdate }: { canUpdate: boolean }) {
  const { t } = useI18n()
  const [items, setItems] = useState<Subscription[]>([])
  const [userId, setUserId] = useState('')
  const [plan, setPlan] = useState('pro')
  const [status, setStatus] = useState('trialing')
  const [trialEndsAt, setTrialEndsAt] = useState('')
  const [notice, setNotice] = useState('')
  const planLabel = (value: string) => value === 'free' ? t('admin.free') : value === 'pro' ? t('admin.pro') : value === 'enterprise' ? t('admin.enterprise') : value
  const statusLabel = (value: string) => value === 'trialing' ? t('subscription.trialing') : value === 'active' ? t('admin.active') : value === 'past_due' ? t('subscription.pastDue') : value === 'cancelled' ? t('subscription.cancelled') : value === 'expired' ? t('subscription.expired') : value

  async function load() {
    try {
      const response = await fetchWithTimeout('/api/admin/v1/plans/subscriptions?limit=50', { cache: 'no-store' })
      const payload = await response.json().catch(() => null) as { items?: Subscription[]; error?: string } | null
      setItems(payload?.items ?? [])
      if (!response.ok) setNotice(response.status >= 500 ? t('subscription.billingUnavailable') : payload?.error ?? t('subscription.loadFailed'))
    } catch (loadError) {
      setItems([])
      setNotice(loadError instanceof Error ? loadError.message : t('subscription.loadFailed'))
    }
  }
  useEffect(() => { void load() }, [])
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!userId.trim()) return
    const response = await fetch('/api/admin/v1/plans/subscriptions', { method: 'PATCH', headers: adminMutationHeaders(), body: JSON.stringify({ userId: userId.trim(), plan, status, trialEndsAt: status === 'trialing' ? new Date(trialEndsAt).toISOString() : null, reason: 'Updating a customer subscription after a reviewed billing decision' }) })
    const payload = await response.json().catch(() => null) as { error?: string } | null
    setNotice(response.ok ? t('subscription.updated') : payload?.error ?? t('subscription.updateFailed'))
    if (response.ok) { setUserId(''); setTrialEndsAt(''); await load() }
  }
  return <Card style={{ padding: 20, display: 'grid', gap: 16 }}><div><h2 style={{ margin: 0, fontSize: 16 }}>{t('subscription.title')}</h2><p style={{ margin: '6px 0 0', color: 'var(--text-muted)', fontSize: 12 }}>{t('subscription.description')}</p></div>{notice && <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>{notice}</div>}<form onSubmit={(event) => void save(event)} style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1.4fr) repeat(3, minmax(120px, 1fr)) auto', gap: 10, alignItems: 'end' }}><label style={labelStyle}>{t('subscription.userId')}<input required value={userId} onChange={(event) => setUserId(event.target.value)} style={inputStyle} /></label><label style={labelStyle}>{t('admin.plan')}<select value={plan} onChange={(event) => setPlan(event.target.value)} style={inputStyle}><option value="free">{t('admin.free')}</option><option value="pro">{t('admin.pro')}</option><option value="enterprise">{t('admin.enterprise')}</option></select></label><label style={labelStyle}>{t('subscription.state')}<select value={status} onChange={(event) => setStatus(event.target.value)} style={inputStyle}><option value="trialing">{t('subscription.trialing')}</option><option value="active">{t('admin.active')}</option><option value="past_due">{t('subscription.pastDue')}</option><option value="cancelled">{t('subscription.cancelled')}</option><option value="expired">{t('subscription.expired')}</option></select></label><label style={labelStyle}>{t('subscription.trialEnds')}<input type="datetime-local" required={status === 'trialing'} value={trialEndsAt} onChange={(event) => setTrialEndsAt(event.target.value)} style={inputStyle} /></label><Btn variant="primary" disabled={!canUpdate}>{t('common.save')}</Btn></form><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>{t('admin.user')}</th><th>{t('admin.plan')}</th><th>{t('subscription.state')}</th><th>{t('subscription.trialEnd')}</th><th>{t('subscription.periodEnd')}</th></tr></thead><tbody>{items.length === 0 ? <tr><td colSpan={5}>{t('subscription.empty')}</td></tr> : items.map(item => <tr key={item.id}><td>{item.user.name ?? t('admin.unnamed')} · {item.user.email}</td><td>{planLabel(item.plan)}</td><td>{statusLabel(item.status)}{item.cancelAtPeriodEnd ? ` · ${t('subscription.ending')}` : ''}</td><td>{item.trialEndsAt ? new Date(item.trialEndsAt).toLocaleString() : '—'}</td><td>{item.currentPeriodEnd ? new Date(item.currentPeriodEnd).toLocaleString() : '—'}</td></tr>)}</tbody></table></div></Card>
}

const labelStyle = { display: 'grid', gap: 6, color: 'var(--text-muted)', fontSize: 12 }
const inputStyle = { width: '100%', boxSizing: 'border-box' as const, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg)', color: 'var(--text)', font: 'inherit', fontSize: 12 }
