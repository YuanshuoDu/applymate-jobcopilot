'use client'

import React, { useEffect, useState } from 'react'
import { Plus, RefreshCw, Save, ToggleLeft, ToggleRight } from 'lucide-react'
import { buildEntitlementPatch, buildPlanPatch, toPlanCatalogDto, type EntitlementKind, type EntitlementValue, type PlanCatalogDto, type PlanKey } from '@/lib/admin/plans'

export function formatPlanMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency, minimumFractionDigits: 2 }).format(cents / 100)
}

export function groupPlanEntitlements(items: Array<Pick<EntitlementValue, 'featureKey' | 'kind'>>): Record<EntitlementKind, string[]> {
  return items.reduce<Record<EntitlementKind, string[]>>((groups, item) => {
    groups[item.kind].push(item.featureKey)
    return groups
  }, { boolean: [], limit: [], text: [] })
}

interface Transition { id: string; fromPlan: PlanKey; toPlan: PlanKey; enabled: boolean; note?: string; version: number }

export function PlansPage() {
  const [plans, setPlans] = useState<PlanCatalogDto[]>([])
  const [transitions, setTransitions] = useState<Transition[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [transitionError, setTransitionError] = useState('')

  async function load() {
    setLoading(true); setError(''); setTransitionError('')
    try {
      const [plansResponse, transitionsResponse] = await Promise.all([fetch('/api/admin/v1/plans', { cache: 'no-store' }), fetch('/api/admin/v1/plans/transitions', { cache: 'no-store' })])
      const planBody = await plansResponse.json() as { plans?: unknown[]; error?: string }
      const transitionBody = await transitionsResponse.json() as { items?: Transition[]; error?: string }
      if (!plansResponse.ok) throw new Error(planBody.error ?? 'Unable to load plans')
      setPlans((planBody.plans ?? []).map(toPlanCatalogDto))
      if (!transitionsResponse.ok) {
        setTransitions([])
        setTransitionError('Transition controls are unavailable until the production plan-transition migration is applied.')
      } else {
        setTransitions(transitionBody.items ?? [])
      }
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : 'Unable to load plans') }
    finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [])

  const transitionRows = plans.flatMap(from => plans.filter(to => to.plan !== from.plan).map(to => transitions.find(item => item.fromPlan === from.plan && item.toPlan === to.plan) ?? { id: `new-${from.plan}-${to.plan}`, fromPlan: from.plan as PlanKey, toPlan: to.plan as PlanKey, enabled: false, version: 1 }))

  return <div style={{ maxWidth: 1180, margin: '0 auto' }}>
    <header style={headerStyle}><div><div style={eyebrow}>Commercial controls</div><h1 style={titleStyle}>Plans</h1><p style={muted}>Manage catalogue pricing, entitlements and allowed manual transitions.</p></div><button type="button" title="Refresh plans" onClick={() => void load()} style={iconButton}><RefreshCw size={16} aria-hidden="true" /></button></header>
    {error && <ErrorBox text={error} />}
    {loading ? <p style={muted}>Loading plans…</p> : <>
      <section style={section}><div style={sectionHeader}><h2 style={heading}>Plan catalogue</h2></div>{plans.length > 0 && <div style={planGrid}>{plans.map(plan => <PlanCard key={plan.id} plan={plan} onSaved={load} />)}</div>}{plans.length === 0 && <p style={muted}>No plans have been seeded yet.</p>}</section>
      <section style={section}><h2 style={heading}>Manual transitions</h2><p style={muted}>Only enabled transitions can be used when changing a user plan.</p>{transitionError ? <ErrorBox text={transitionError} /> : <div style={{ overflowX: 'auto' }}><table style={table}><thead><tr><th>From</th><th>To</th><th>Status</th><th>Note</th><th /></tr></thead><tbody>{transitionRows.map(item => <TransitionRow key={item.id} transition={item} onSaved={load} />)}</tbody></table></div>}</section>
    </>}
  </div>
}

function PlanCard({ plan, onSaved }: { plan: PlanCatalogDto; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState(plan)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => setDraft(plan), [plan])
  async function save() {
    if (reason.trim().length < 10) return
    setBusy(true)
    try {
      const response = await fetch(`/api/admin/v1/plans/${plan.plan}`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ ...buildPlanPatch(draft), version: plan.version, reason }) })
      if (!response.ok) throw new Error('Plan update failed')
      await onSaved(); setReason('')
    } finally { setBusy(false) }
  }
  async function saveEntitlements() {
    if (reason.trim().length < 10) return
    setBusy(true)
    try {
      const response = await fetch(`/api/admin/v1/plans/${plan.plan}/entitlements`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ version: plan.version, entitlements: buildEntitlementPatch(draft.entitlements), reason }) })
      if (!response.ok) throw new Error('Entitlement update failed')
      await onSaved(); setReason('')
    } finally { setBusy(false) }
  }
  async function toggleActive() {
    if (reason.trim().length < 10) return
    setBusy(true)
    try {
      const response = await fetch(`/api/admin/v1/plans/${plan.plan}`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ ...buildPlanPatch({ ...draft, active: !draft.active }), version: plan.version, reason }) })
      if (!response.ok) throw new Error('Plan status update failed')
      await onSaved(); setReason('')
    } finally { setBusy(false) }
  }
  return <article style={card}><div style={cardHeader}><div><h3 style={{ margin: 0, fontSize: 17 }}>{plan.name}</h3><span style={muted}>{plan.plan} · v{plan.version}</span></div><span style={{ ...status, background: plan.active ? '#e7f6ef' : '#eef1f5', color: plan.active ? '#13734f' : '#5b6b80' }}>{plan.active ? 'Active' : 'Inactive'}</span></div><div style={priceRow}><label>Monthly<input type="number" min="0" value={draft.monthlyPriceCents} onChange={event => setDraft({ ...draft, monthlyPriceCents: Number(event.target.value) })} style={smallInput} /></label><label>Yearly<input type="number" min="0" value={draft.yearlyPriceCents} onChange={event => setDraft({ ...draft, yearlyPriceCents: Number(event.target.value) })} style={smallInput} /></label><div style={{ ...muted, alignSelf: 'end', paddingBottom: 7 }}>{formatPlanMoney(draft.monthlyPriceCents, draft.currency)} / month</div></div><label style={label}>Description<textarea value={draft.description ?? ''} onChange={event => setDraft({ ...draft, description: event.target.value })} rows={2} style={textarea} /></label><label style={label}>Audit reason<input value={reason} onChange={event => setReason(event.target.value)} placeholder="At least 10 characters" style={textInput} /></label><div style={buttonRow}><button type="button" disabled={busy || reason.trim().length < 10} onClick={() => void save()} style={primary}><Save size={14} aria-hidden="true" /> Save plan</button><button type="button" disabled={busy || reason.trim().length < 10} onClick={() => void saveEntitlements()} style={secondary}><Save size={14} aria-hidden="true" /> Save entitlements</button><button type="button" disabled={busy || reason.trim().length < 10} onClick={() => void toggleActive()} style={secondary}>{draft.active ? 'Deactivate' : 'Activate'}</button></div><div style={entitlements}><strong style={{ fontSize: 12 }}>Entitlements</strong>{draft.entitlements.map((item, index) => <div key={item.id} style={entitlementRow}><input value={item.featureKey} onChange={event => updateEntitlement(index, { featureKey: event.target.value }, draft, setDraft)} style={smallInput} /><select value={item.kind} onChange={event => updateEntitlement(index, { kind: event.target.value as EntitlementKind }, draft, setDraft)} style={smallInput}><option value="boolean">Boolean</option><option value="limit">Limit</option><option value="text">Text</option></select><input type="checkbox" checked={item.enabled} onChange={event => updateEntitlement(index, { enabled: event.target.checked }, draft, setDraft)} aria-label={`${item.featureKey} enabled`} />{item.kind === 'limit' && <input type="number" min="0" value={item.limit ?? 0} onChange={event => updateEntitlement(index, { limit: Number(event.target.value) }, draft, setDraft)} style={smallInput} />}{item.kind === 'text' && <input value={item.textValue ?? ''} onChange={event => updateEntitlement(index, { textValue: event.target.value }, draft, setDraft)} placeholder="Text value" style={smallInput} aria-label={`${item.featureKey} text value`} />}</div>)}<button type="button" style={secondary} onClick={() => setDraft({ ...draft, entitlements: [...draft.entitlements, { id: `draft-${Date.now()}`, featureKey: 'new_feature', kind: 'boolean', enabled: false }] })}><Plus size={14} aria-hidden="true" /> Add entitlement</button></div></article>
}

function updateEntitlement(index: number, patch: Partial<EntitlementValue>, draft: PlanCatalogDto, setDraft: (next: PlanCatalogDto) => void) { setDraft({ ...draft, entitlements: draft.entitlements.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) }) }
function TransitionRow({ transition, onSaved }: { transition: Transition; onSaved: () => Promise<void> }) {
  const [reason, setReason] = useState('')
  async function toggle() { if (reason.trim().length < 10) return; const response = await fetch('/api/admin/v1/plans/transitions', { method: 'PATCH', headers: headers(), body: JSON.stringify({ ...transition, enabled: !transition.enabled, reason }) }); if (response.ok) { setReason(''); await onSaved() } }
  return <tr><td>{transition.fromPlan}</td><td>{transition.toPlan}</td><td><button type="button" title={transition.enabled ? 'Disable transition' : 'Enable transition'} onClick={() => void toggle()} style={iconButton}>{transition.enabled ? <ToggleRight size={19} color="#13734f" aria-hidden="true" /> : <ToggleLeft size={19} aria-hidden="true" />}</button></td><td>{transition.note || <span style={muted}>No note</span>}</td><td><input value={reason} onChange={event => setReason(event.target.value)} placeholder="Reason" style={smallInput} aria-label={`${transition.fromPlan} to ${transition.toPlan} reason`} /></td></tr>
}

function headers(): HeadersInit { return { 'Content-Type': 'application/json', Origin: window.location.origin, 'Idempotency-Key': `${Date.now()}-${Math.random().toString(36).slice(2)}` } }
function ErrorBox({ text }: { text: string }) { return <div role="alert" style={{ marginBottom: 14, padding: 10, border: '1px solid #e6b8b8', color: '#a32d2d', background: '#fff8f8', borderRadius: 6 }}>{text}</div> }
const headerStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 22 }
const eyebrow = { color: '#5b6b80', fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '.08em' }
const titleStyle = { margin: '5px 0 0', fontSize: 28 }
const muted = { color: '#5b6b80', fontSize: 12 }
const section = { background: '#fff', border: '1px solid #d9e2ec', borderRadius: 8, padding: 18, marginBottom: 16 }
const sectionHeader = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }
const heading = { margin: '0 0 14px', fontSize: 16 }
const planGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 14 }
const card = { border: '1px solid #d9e2ec', borderRadius: 7, padding: 15 }
const cardHeader = { display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 14 }
const status = { alignSelf: 'start', padding: '3px 7px', borderRadius: 999, fontSize: 11, fontWeight: 700 }
const priceRow = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 11 }
const label = { display: 'grid', gap: 5, color: '#5b6b80', fontSize: 11, marginBottom: 9 }
const textInput = { minHeight: 32, border: '1px solid #c9d5e1', borderRadius: 5, padding: '0 8px', font: 'inherit', color: '#172033' }
const smallInput = { minHeight: 30, minWidth: 0, border: '1px solid #c9d5e1', borderRadius: 5, padding: '0 6px', font: 'inherit', color: '#172033', background: '#fff' }
const textarea = { border: '1px solid #c9d5e1', borderRadius: 5, padding: 7, font: 'inherit', resize: 'vertical' as const, color: '#172033' }
const primary = { minHeight: 32, display: 'inline-flex', alignItems: 'center', gap: 5, border: 0, borderRadius: 6, padding: '0 10px', background: '#146c94', color: '#fff', cursor: 'pointer', fontWeight: 700, fontSize: 12 }
const secondary = { ...primary, background: '#fff', color: '#146c94', border: '1px solid #9db8ca' }
const buttonRow = { display: 'flex', flexWrap: 'wrap' as const, gap: 7, marginBottom: 14 }
const entitlements = { borderTop: '1px solid #e5ebf1', paddingTop: 12, display: 'grid', gap: 7 }
const entitlementRow = { display: 'grid', gridTemplateColumns: 'minmax(80px,1fr) 90px 25px minmax(50px,80px)', gap: 5, alignItems: 'center' }
const iconButton = { width: 32, height: 32, display: 'inline-grid', placeItems: 'center', border: '1px solid #c9d5e1', borderRadius: 5, background: '#fff', cursor: 'pointer' }
const table = { width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }
