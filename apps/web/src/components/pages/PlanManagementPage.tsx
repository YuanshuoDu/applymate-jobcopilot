'use client'

import React, { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Save, ShieldAlert } from 'lucide-react'
import { TopBar } from '@/components/layout/TopBar'
import { Btn, Card } from '@/components/ui'
import { apiMutate, useApi } from '@/lib/hooks'
import type { BillingInterval, PlanCatalogueRecord, PlanKey } from '@/lib/plan-catalogue-shared'
import { AdminSubscriptionControls } from '@/components/admin/AdminSubscriptionControls'

type PlansResponse = { plans: PlanCatalogueRecord[] }

const INTERVALS: BillingInterval[] = ['forever', 'month', 'year']

function updatePlan(plans: PlanCatalogueRecord[], key: PlanKey, patch: Partial<PlanCatalogueRecord>) {
  return plans.map(plan => plan.key === key ? { ...plan, ...patch } : plan)
}

function priceLabel(plan: PlanCatalogueRecord): string {
  const period = plan.interval === 'forever' ? 'one-time' : `per ${plan.interval}`
  return `Price (${plan.currency} ${period})`
}

export function PlanManagementPage({ canUpdate = true, canViewObservability = true }: { canUpdate?: boolean; canViewObservability?: boolean }) {
  const { data, loading, error, refetch } = useApi<PlansResponse>('/api/admin/v1/plans')
  const [plans, setPlans] = useState<PlanCatalogueRecord[]>([])
  const [selectedKey, setSelectedKey] = useState<PlanKey>('free')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!data?.plans) return
    setPlans(data.plans)
    setSelectedKey(current => data.plans.some(plan => plan.key === current) ? current : data.plans[0]?.key ?? 'free')
  }, [data])

  const availablePlans = useMemo(
    () => plans.length ? plans : data?.plans ?? [],
    [data?.plans, plans],
  )
  const selected = useMemo(() => availablePlans.find(plan => plan.key === selectedKey) ?? null, [availablePlans, selectedKey])

  function patchSelected(patch: Partial<PlanCatalogueRecord>) {
    setSaved(false)
    setSaveError(null)
    setPlans(current => updatePlan(current, selectedKey, patch))
  }

  async function save() {
    if (!plans.length) return
    setSaving(true)
    setSaveError(null)
    setSaved(false)
    const result = await apiMutate<PlansResponse>('/api/admin/v1/plans', 'PATCH', { plans })
    setSaving(false)
    if (result.error) {
      setSaveError(result.error)
      return
    }
    if (result.data?.plans) setPlans(result.data.plans)
    setSaved(true)
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg)' }}>
      <TopBar title="Plan management">
        {canViewObservability && <Link href="/admin/observability" style={{ color: 'var(--text-muted)', fontSize: 12, textDecoration: 'none' }}>Observability</Link>}
        <Btn small variant="ghost" onClick={refetch}>Refresh</Btn>
      </TopBar>

      <main style={{ maxWidth: 960, padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {loading && !data && <Card style={{ padding: 16, color: 'var(--text-muted)', fontSize: 12 }}>Loading plan catalogue…</Card>}
        {(error || saveError) && (
          <Card style={{ padding: 14, borderColor: 'rgba(220,38,38,0.25)', color: 'var(--c-danger)', display: 'flex', gap: 8, alignItems: 'center' }}>
            <ShieldAlert size={15} aria-hidden="true" />
            {error ?? saveError}
          </Card>
        )}
        {availablePlans.length > 0 && selected && (
          <>
            <Card style={{ padding: 16 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {availablePlans.map(plan => (
                  <button key={plan.key} type="button" onClick={() => setSelectedKey(plan.key)} style={{ border: `1px solid ${plan.key === selectedKey ? 'var(--primary)' : 'var(--border)'}`, background: plan.key === selectedKey ? 'rgba(79,70,229,0.08)' : 'var(--bg)', color: 'var(--text)', borderRadius: 8, padding: '8px 12px', cursor: 'pointer', fontSize: 12 }}>
                    {plan.name}
                  </button>
                ))}
              </div>
            </Card>

            <Card style={{ padding: 20 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
                <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Display name<input value={selected.name} onChange={event => patchSelected({ name: event.target.value })} style={inputStyle} /></label>
                <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>{priceLabel(selected)}<input type="number" min="0" step="0.01" value={selected.priceMinor / 100} onChange={event => patchSelected({ priceMinor: Math.max(0, Math.round(Number(event.target.value || 0) * 100)) })} style={inputStyle} /></label>
                <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Currency<input value={selected.currency} maxLength={3} onChange={event => patchSelected({ currency: event.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) })} style={inputStyle} /></label>
                <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Billing interval<select value={selected.interval} onChange={event => patchSelected({ interval: event.target.value as BillingInterval })} style={inputStyle}>{INTERVALS.map(interval => <option key={interval} value={interval}>{interval}</option>)}</select></label>
                <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Display order<input type="number" min="0" max="1000" step="1" value={selected.sortOrder} onChange={event => patchSelected({ sortOrder: Math.max(0, Math.min(1000, Math.trunc(Number(event.target.value || 0)))) })} style={inputStyle} /></label>
                <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Trial days<input type="number" min="0" max="365" value={selected.trialDays} onChange={event => patchSelected({ trialDays: Math.max(0, Math.min(365, Number(event.target.value || 0))) })} style={inputStyle} /></label>
                <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Badge<input value={selected.badge ?? ''} onChange={event => patchSelected({ badge: event.target.value || null })} style={inputStyle} /></label>
                <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Call to action<input value={selected.cta} onChange={event => patchSelected({ cta: event.target.value })} style={inputStyle} /></label>
              </div>
              <label style={{ display: 'block', marginTop: 14, fontSize: 12, color: 'var(--text-muted)' }}>Description<textarea value={selected.description} onChange={event => patchSelected({ description: event.target.value })} rows={3} style={{ ...inputStyle, resize: 'vertical' }} /></label>
              <label style={{ display: 'block', marginTop: 14, fontSize: 12, color: 'var(--text-muted)' }}>Features (one per line)<textarea value={selected.features.join('\n')} onChange={event => patchSelected({ features: event.target.value.split('\n').map(item => item.trim()).filter(Boolean) })} rows={7} style={{ ...inputStyle, resize: 'vertical' }} /></label>
              <label style={{ display: 'block', marginTop: 14, fontSize: 12, color: 'var(--text-muted)' }}>Entitlements (one per line)<textarea value={selected.entitlements.join('\n')} onChange={event => patchSelected({ entitlements: event.target.value.split('\n').map(item => item.trim()).filter(Boolean) })} rows={5} style={{ ...inputStyle, resize: 'vertical' }} /></label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 12, color: 'var(--text)' }}><input type="checkbox" checked={selected.active} onChange={event => patchSelected({ active: event.target.checked })} /> Publicly active</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 18 }}>
                <Btn variant="primary" onClick={save} disabled={saving || !canUpdate}><Save size={14} aria-hidden="true" />{saving ? 'Saving…' : 'Save plan'}</Btn>
                {!canUpdate && <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>You can view plans but do not have permission to edit them.</span>}
                {saved && <span style={{ color: 'var(--c-success)', fontSize: 12 }}>Saved</span>}
              </div>
            </Card>
          </>
        )}
        <AdminSubscriptionControls canUpdate={canUpdate} />
      </main>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  display: 'block', width: '100%', marginTop: 6, boxSizing: 'border-box', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg)', color: 'var(--text)', font: 'inherit', fontSize: 12,
}
