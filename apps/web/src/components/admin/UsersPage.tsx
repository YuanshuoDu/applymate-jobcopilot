'use client'

import React, { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, PauseCircle, PlayCircle, RefreshCw } from 'lucide-react'

export interface AdminUserRow { id: string; email: string; name: string; plan: string; accountStatus: string; region: string; createdAt: string; updatedAt: string; suspendedAt: string | null; counts: { resumes: number; jobs: number; applicationTasks: number } }
interface AdminPlanOption { plan: string; name: string; active: boolean; version: number }
interface FeatureOverride { id: string; featureKey: string; enabled: boolean; limit: number | null; expiresAt: string | null; reason: string; updatedAt: string | null }

export function userRowLabel(user: Pick<AdminUserRow, 'name' | 'email' | 'plan' | 'accountStatus'>) { return `${user.name} · ${user.email} · ${user.plan} · ${user.accountStatus}` }

function key() { return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `admin-${Date.now()}` }

export function UsersPage({ userId }: { userId?: string }) {
  const [users, setUsers] = useState<AdminUserRow[]>([])
  const [user, setUser] = useState<AdminUserRow | null>(null)
  const [planChanges, setPlanChanges] = useState<Array<{ id: string; fromPlan: string; toPlan: string; createdAt: string }>>([])
  const [q, setQ] = useState(''); const [status, setStatus] = useState(''); const [plan, setPlan] = useState('')
  const [loading, setLoading] = useState(true); const [error, setError] = useState('')

  async function load() {
    setLoading(true); setError('')
    try {
      const query = userId ? `/api/admin/v1/users/${userId}` : `/api/admin/v1/users?limit=50${q ? `&q=${encodeURIComponent(q)}` : ''}${status ? `&status=${status}` : ''}${plan ? `&plan=${plan}` : ''}`
      const response = await fetch(query, { cache: 'no-store' }); const body = await response.json() as { items?: AdminUserRow[]; user?: AdminUserRow; planChanges?: typeof planChanges; error?: string }
      if (!response.ok) throw new Error(body.error ?? 'Unable to load users')
      if (userId) { setUser(body.user ?? null); setPlanChanges(body.planChanges ?? []) } else setUsers(body.items ?? [])
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : 'Unable to load users') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [userId])

  if (userId) return <UserDetail user={user} planChanges={planChanges} loading={loading} error={error} onReload={() => void load()} />
  return <div style={{ maxWidth: 1180, margin: '0 auto' }}><header style={headerStyle}><div><div style={eyebrow}>Accounts</div><h1 style={titleStyle}>Users</h1><p style={muted}>Search masked profiles and manage account state.</p></div><button type="button" title="Refresh users" onClick={() => void load()} style={iconButton}><RefreshCw size={16} aria-hidden="true" /></button></header>{error && <ErrorBox text={error} />}<form onSubmit={event => { event.preventDefault(); void load() }} style={filterBar}><input value={q} onChange={event => setQ(event.target.value)} placeholder="Search name or email" style={input} /><select value={plan} onChange={event => setPlan(event.target.value)} style={input}><option value="">All plans</option><option value="free">Free</option><option value="pro">Pro</option><option value="enterprise">Enterprise</option></select><select value={status} onChange={event => setStatus(event.target.value)} style={input}><option value="">All states</option><option value="active">Active</option><option value="suspended">Suspended</option></select><button type="submit" style={primary}>Search</button></form><section style={section}><div style={{ overflowX: 'auto' }}><table style={table}><thead><tr><th>User</th><th>Plan</th><th>State</th><th>Usage metadata</th></tr></thead><tbody>{loading ? <tr><td colSpan={4}>Loading…</td></tr> : users.map(item => <tr key={item.id}><td><Link href={`/admin/users/${item.id}`} style={link}><strong>{item.name || 'Unnamed'}</strong><span style={{ display: 'block', fontSize: 11, color: '#687b90' }}>{item.email}</span></Link></td><td>{item.plan}</td><td><Status value={item.accountStatus} /></td><td>{item.counts.jobs} jobs · {item.counts.resumes} resumes · {item.counts.applicationTasks} tasks</td></tr>)}</tbody></table></div></section></div>
}

function UserDetail({ user, planChanges, loading, error, onReload }: { user: AdminUserRow | null; planChanges: Array<{ id: string; fromPlan: string; toPlan: string; createdAt: string }>; loading: boolean; error: string; onReload: () => void }) {
  const [busy, setBusy] = useState(false)
  const [plans, setPlans] = useState<AdminPlanOption[]>([])
  const [transitions, setTransitions] = useState<Array<{ fromPlan: string; toPlan: string; enabled: boolean }>>([])
  const [overrides, setOverrides] = useState<FeatureOverride[]>([])
  const [selectedPlan, setSelectedPlan] = useState('')
  const [reason, setReason] = useState('')
  const [overrideKey, setOverrideKey] = useState('auto_apply')
  const [overrideEnabled, setOverrideEnabled] = useState(false)
  const [overrideLimit, setOverrideLimit] = useState('')
  const [overrideExpiry, setOverrideExpiry] = useState('')
  const [overrideReason, setOverrideReason] = useState('')
  useEffect(() => {
    if (!user) return
    setSelectedPlan(user.plan)
    void Promise.all([fetch('/api/admin/v1/plans', { cache: 'no-store' }), fetch('/api/admin/v1/plans/transitions', { cache: 'no-store' }), fetch(`/api/admin/v1/users/${user.id}/feature-overrides`, { cache: 'no-store' })]).then(async ([plansResponse, transitionResponse, overrideResponse]) => {
      const plansBody = await plansResponse.json() as { items?: AdminPlanOption[] }
      const transitionBody = await transitionResponse.json() as { items?: Array<{ fromPlan: string; toPlan: string; enabled: boolean }> }
      const overrideBody = await overrideResponse.json() as { items?: FeatureOverride[] }
      setPlans(plansBody.items ?? []); setTransitions(transitionBody.items ?? []); setOverrides(overrideBody.items ?? [])
    }).catch(() => undefined)
  }, [user])
  async function changeState(next: 'active' | 'suspended') { if (!user || !window.confirm(`${next === 'suspended' ? 'Suspend' : 'Restore'} this account?`)) return; const reason = window.prompt('Reason (10-500 characters)')?.trim() ?? ''; if (reason.length < 10) return; setBusy(true); const response = await fetch(`/api/admin/v1/users/${user.id}/account-state`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: window.location.origin, 'Idempotency-Key': key() }, body: JSON.stringify({ status: next, updatedAt: user.updatedAt, reason }) }); setBusy(false); if (response.ok) onReload(); }
  if (loading) return <div style={muted}>Loading user…</div>
  if (!user) return <ErrorBox text={error || 'User not found'} />
  async function changePlan() {
    if (!user || selectedPlan === user.plan || reason.trim().length < 10) return
    setBusy(true)
    try { const response = await fetch(`/api/admin/v1/users/${user.id}/plan`, { method: 'PATCH', headers: { ...headers(), 'Idempotency-Key': key() }, body: JSON.stringify({ toPlan: selectedPlan, updatedAt: user.updatedAt, reason }) }); if (!response.ok) throw new Error('Plan change failed'); setReason(''); await onReload() } finally { setBusy(false) }
  }
  async function saveOverride() {
    if (!user || overrideReason.trim().length < 10) return
    setBusy(true)
    try { const response = await fetch(`/api/admin/v1/users/${user.id}/feature-overrides`, { method: 'PATCH', headers: { ...headers(), 'Idempotency-Key': key() }, body: JSON.stringify({ featureKey: overrideKey, enabled: overrideEnabled, limit: overrideLimit === '' ? null : Number(overrideLimit), expiresAt: overrideExpiry || null, reason: overrideReason }) }); if (!response.ok) throw new Error('Feature override failed'); const body = await response.json() as { override?: FeatureOverride }; if (body.override) setOverrides(current => [...current.filter(item => item.featureKey !== body.override?.featureKey), body.override as FeatureOverride].sort((a, b) => a.featureKey.localeCompare(b.featureKey))); setOverrideReason('') } finally { setBusy(false) }
  }
  const availablePlans = plans.filter(item => item.active && item.plan !== user.plan && transitions.some(transition => transition.fromPlan === user.plan && transition.toPlan === item.plan && transition.enabled))
  return <div style={{ maxWidth: 900, margin: '0 auto' }}><Link href="/admin/users" style={link}><ArrowLeft size={14} aria-hidden="true" /> Back to users</Link><header style={{ ...headerStyle, marginTop: 18 }}><div><div style={eyebrow}>Masked account</div><h1 style={titleStyle}>{user.name || 'Unnamed'}</h1><p style={muted}>{user.email} · {user.region || 'Region unavailable'}</p></div><Status value={user.accountStatus} /></header>{error && <ErrorBox text={error} />}<section style={section}><h2 style={heading}>Account controls</h2><div style={detailGrid}><div><span style={muted}>Plan</span><strong style={{ display: 'block', marginTop: 4 }}>{user.plan}</strong></div><div><span style={muted}>Jobs</span><strong style={{ display: 'block', marginTop: 4 }}>{user.counts.jobs}</strong></div><div><span style={muted}>Resumes</span><strong style={{ display: 'block', marginTop: 4 }}>{user.counts.resumes}</strong></div><div><span style={muted}>Tasks</span><strong style={{ display: 'block', marginTop: 4 }}>{user.counts.applicationTasks}</strong></div></div><button type="button" disabled={busy} onClick={() => void changeState(user.accountStatus === 'suspended' ? 'active' : 'suspended')} style={user.accountStatus === 'suspended' ? primary : danger}>{user.accountStatus === 'suspended' ? <PlayCircle size={15} aria-hidden="true" /> : <PauseCircle size={15} aria-hidden="true" />}{user.accountStatus === 'suspended' ? 'Restore account' : 'Suspend account'}</button></section><section style={section}><h2 style={heading}>Manual plan adjustment</h2><div style={inlineForm}><select value={selectedPlan} onChange={event => setSelectedPlan(event.target.value)} style={input}><option value={user.plan}>{user.plan} (current)</option>{availablePlans.map(item => <option key={item.plan} value={item.plan}>{item.name}</option>)}</select><input value={reason} onChange={event => setReason(event.target.value)} placeholder="Reason (10-500 characters)" style={{ ...input, flex: 1 }} /><button type="button" disabled={busy || selectedPlan === user.plan || reason.trim().length < 10 || user.accountStatus === 'suspended'} onClick={() => void changePlan()} style={primary}>Apply plan</button></div>{user.accountStatus === 'suspended' && <p style={muted}>Restore the account before changing its plan.</p>}</section><section style={section}><h2 style={heading}>Feature override</h2><div style={overrideGrid}><select value={overrideKey} onChange={event => setOverrideKey(event.target.value)} style={input}>{['ai_credits', 'job_discovery', 'auto_apply', 'tailored_resume', 'cover_letter', 'gmail_tracking', 'api_access'].map(item => <option key={item} value={item}>{item}</option>)}</select><label style={checkLabel}><input type="checkbox" checked={overrideEnabled} onChange={event => setOverrideEnabled(event.target.checked)} /> Enabled</label><input type="number" min="0" value={overrideLimit} onChange={event => setOverrideLimit(event.target.value)} placeholder="Limit" style={input} /><input type="datetime-local" value={overrideExpiry} onChange={event => setOverrideExpiry(event.target.value)} style={input} /><input value={overrideReason} onChange={event => setOverrideReason(event.target.value)} placeholder="Reason (10-500 characters)" style={{ ...input, gridColumn: 'span 2' }} /><button type="button" disabled={busy || overrideReason.trim().length < 10} onClick={() => void saveOverride()} style={primary}>Save override</button></div>{overrides.length > 0 && <ul style={{ margin: '14px 0 0', paddingLeft: 18 }}>{overrides.map(item => <li key={item.id} style={{ marginBottom: 6 }}>{item.featureKey}: {item.enabled ? 'enabled' : 'disabled'}{item.limit === null ? '' : ` · limit ${item.limit}`}{item.expiresAt ? ` · until ${new Date(item.expiresAt).toLocaleDateString()}` : ''}</li>)}</ul>}</section><section style={section}><h2 style={heading}>Plan change history</h2>{planChanges.length === 0 ? <p style={muted}>No manual changes recorded.</p> : <ul style={{ margin: 0, paddingLeft: 18 }}>{planChanges.map(change => <li key={change.id} style={{ marginBottom: 7 }}>{change.fromPlan} → {change.toPlan} <span style={muted}>({new Date(change.createdAt).toLocaleDateString()})</span></li>)}</ul>}</section></div>
}

function Status({ value }: { value: string }) { return <span style={{ display: 'inline-block', padding: '3px 7px', borderRadius: 999, background: value === 'active' ? '#e7f6ef' : '#fff1e8', color: value === 'active' ? '#13734f' : '#a34b19', fontSize: 11, fontWeight: 700 }}>{value}</span> }
function ErrorBox({ text }: { text: string }) { return <div role="alert" style={{ marginBottom: 14, padding: 10, border: '1px solid #e6b8b8', color: '#a32d2d', background: '#fff8f8', borderRadius: 6 }}>{text}</div> }
const headerStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 22 }
const eyebrow = { color: '#5b6b80', fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '.08em' }
const titleStyle = { margin: '5px 0 0', fontSize: 28 }
const muted = { color: '#5b6b80', fontSize: 12 }
const section = { background: '#fff', border: '1px solid #d9e2ec', borderRadius: 8, padding: 18, marginBottom: 16 }
const filterBar = { display: 'flex', gap: 8, flexWrap: 'wrap' as const, marginBottom: 14 }
const input = { minHeight: 34, border: '1px solid #c9d5e1', borderRadius: 5, padding: '0 9px', background: '#fff', color: '#172033', font: 'inherit' }
const primary = { minHeight: 34, display: 'inline-flex', alignItems: 'center', gap: 6, border: 0, borderRadius: 6, padding: '0 13px', background: '#146c94', color: '#fff', cursor: 'pointer', fontWeight: 700 }
const danger = { ...primary, background: '#a32d2d' }
const iconButton = { width: 32, height: 32, display: 'inline-grid', placeItems: 'center', border: '1px solid #c9d5e1', borderRadius: 5, background: '#fff', cursor: 'pointer' }
const link = { color: '#146c94', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 5 }
const table = { width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }
const heading = { margin: '0 0 14px', fontSize: 16 }
const detailGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: 16, marginBottom: 18 }
const inlineForm = { display: 'flex', flexWrap: 'wrap' as const, gap: 8, alignItems: 'center' }
const overrideGrid = { display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 8, alignItems: 'center' }
const checkLabel = { display: 'inline-flex', alignItems: 'center', gap: 6, color: '#5b6b80', fontSize: 12 }
function headers(): HeadersInit { return { 'Content-Type': 'application/json', Origin: window.location.origin } }
