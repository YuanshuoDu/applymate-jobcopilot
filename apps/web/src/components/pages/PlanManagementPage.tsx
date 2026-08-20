'use client'

import React, { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { startAuthentication } from '@simplewebauthn/browser'
import { Save, ShieldAlert } from 'lucide-react'
import { TopBar } from '@/components/layout/TopBar'
import { Btn, Card } from '@/components/ui'
import { useApi } from '@/lib/hooks'
import { adminMutationHeaders } from '@/lib/admin/client'
import { useI18n } from '@/lib/i18n'
import type { BillingInterval, PlanCatalogueRecord, PlanKey } from '@/lib/plan-catalogue-shared'
import { AdminSubscriptionControls } from '@/components/admin/AdminSubscriptionControls'
import { PlanEntitlementEditor } from '@/components/admin/PlanEntitlementEditor'
import { PlanFeatureListEditor } from '@/components/admin/PlanFeatureListEditor'

type PlansResponse = { plans: PlanCatalogueRecord[] }
type PlanMutationResponse = PlansResponse & { error?: string; code?: string }

const INTERVALS: BillingInterval[] = ['forever', 'month', 'year']

function updatePlan(plans: PlanCatalogueRecord[], key: PlanKey, patch: Partial<PlanCatalogueRecord>) {
  return plans.map(plan => plan.key === key ? { ...plan, ...patch } : plan)
}

function priceLabel(plan: PlanCatalogueRecord, t: (key: string) => string): string {
  const period = plan.interval === 'forever' ? t('planManagement.oneTime') : `${t('planManagement.per')} ${t(`planManagement.interval.${plan.interval}`)}`
  return `${t('planManagement.price')} (${plan.currency} ${period})`
}

function webAuthnErrorMessage(error: unknown, t: (key: string) => string) {
  const message = error instanceof Error ? error.message : ''
  return /notallowederror|does not have focus|not allowed at this time/i.test(message)
    ? t('planManagement.focusWebAuthn')
    : message || t('planManagement.webAuthnFailed')
}

export function PlanManagementPage({ canUpdate = true, canViewObservability = true }: { canUpdate?: boolean; canViewObservability?: boolean }) {
  const { t } = useI18n()
  const { data, loading, error, refetch } = useApi<PlansResponse>('/api/admin/v1/plans', { timeoutMs: 10_000 })
  const [plans, setPlans] = useState<PlanCatalogueRecord[]>([])
  const [selectedKey, setSelectedKey] = useState<PlanKey>('free')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [reauthRequired, setReauthRequired] = useState(false)

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

  async function persist(nextPlans: PlanCatalogueRecord[]) {
    // The catalogue API accepts editable plan fields only. `id` and `version`
    // are response metadata and must not be sent back as part of the patch.
    const editablePlans = nextPlans.map(({ id: _id, version: _version, ...plan }) => plan)
    const response = await fetch('/api/admin/v1/plans', { method: 'PATCH', headers: adminMutationHeaders(), body: JSON.stringify({ plans: editablePlans }) })
    const payload = await response.json().catch(() => ({})) as PlanMutationResponse
    return { response, payload }
  }

  async function save() {
    if (!plans.length) return
    setSaving(true)
    setSaveError(null)
    setSaved(false)
    try {
      const result = await persist(plans)
      if (!result.response.ok) {
        setReauthRequired(result.payload.code === 'reauth_required')
        setSaveError(result.payload.error ?? t('planManagement.saveFailed'))
        return
      }
      setReauthRequired(false)
      if (result.payload.plans) setPlans(result.payload.plans)
      setSaved(true)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t('planManagement.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  async function reauthenticateAndRetry() {
    if (!plans.length) return
    setSaving(true)
    setSaveError(null)
    try {
      const optionsResponse = await fetch('/api/admin/v1/security/webauthn', { method: 'POST', headers: adminMutationHeaders(), body: JSON.stringify({ action: 'reauth_options' }) })
      const optionsPayload = await optionsResponse.json() as { options?: Parameters<typeof startAuthentication>[0]; challengeId?: string; error?: string }
      if (!optionsResponse.ok || !optionsPayload.options || !optionsPayload.challengeId) throw new Error(optionsPayload.error ?? t('planManagement.startWebAuthnFailed'))
      const response = await startAuthentication(optionsPayload.options)
      const verifyResponse = await fetch('/api/admin/v1/security/webauthn', { method: 'POST', headers: adminMutationHeaders(), body: JSON.stringify({ action: 'reauth_verify', challengeId: optionsPayload.challengeId, response }) })
      const verifyPayload = await verifyResponse.json() as { error?: string }
      if (!verifyResponse.ok) throw new Error(verifyPayload.error ?? t('planManagement.verifyWebAuthnFailed'))

      const result = await persist(plans)
      if (!result.response.ok) {
        setReauthRequired(result.payload.code === 'reauth_required')
        setSaveError(result.payload.error ?? t('planManagement.saveFailed'))
        return
      }
      setReauthRequired(false)
      if (result.payload.plans) setPlans(result.payload.plans)
      setSaved(true)
    } catch (error) {
      setReauthRequired(true)
      setSaveError(webAuthnErrorMessage(error, t))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg)' }}>
      <TopBar title={t('planManagement.title')}>
        {canViewObservability && <Link href="/admin/observability" style={{ color: 'var(--text-muted)', fontSize: 12, textDecoration: 'none' }}>{t('adminUsers.observability')}</Link>}
        <Btn small variant="ghost" onClick={refetch}>{t('common.refresh')}</Btn>
      </TopBar>

      <div style={{ maxWidth: 960, padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {loading && !data && <Card style={{ padding: 16, color: 'var(--text-muted)', fontSize: 12 }}>{t('planManagement.loading')}</Card>}
        {(error || saveError) && (
          <Card style={{ padding: 14, borderColor: 'rgba(220,38,38,0.25)', color: 'var(--c-danger)', display: 'flex', gap: 8, alignItems: 'center' }}>
            <ShieldAlert size={15} aria-hidden="true" />
            <span style={{ flex: 1 }}>{error ?? saveError}</span>
            {reauthRequired && <button type="button" disabled={saving} onClick={() => void reauthenticateAndRetry()} style={retryButton}>{saving ? t('planManagement.authenticating') : t('planManagement.reauthenticate')}</button>}
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
                <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('planManagement.displayName')}<input value={selected.name} onChange={event => patchSelected({ name: event.target.value })} style={inputStyle} /></label>
                <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>{priceLabel(selected, t)}<input type="number" min="0" step="0.01" value={selected.priceMinor / 100} onChange={event => patchSelected({ priceMinor: Math.max(0, Math.round(Number(event.target.value || 0) * 100)) })} style={inputStyle} /></label>
                <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('planManagement.currency')}<input value={selected.currency} maxLength={3} onChange={event => patchSelected({ currency: event.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) })} style={inputStyle} /></label>
                <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('planManagement.billingInterval')}<select value={selected.interval} onChange={event => patchSelected({ interval: event.target.value as BillingInterval })} style={inputStyle}>{INTERVALS.map(interval => <option key={interval} value={interval}>{t(`planManagement.interval.${interval}`)}</option>)}</select></label>
                <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('planManagement.displayOrder')}<input type="number" min="0" max="1000" step="1" value={selected.sortOrder} onChange={event => patchSelected({ sortOrder: Math.max(0, Math.min(1000, Math.trunc(Number(event.target.value || 0)))) })} style={inputStyle} /></label>
                <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('planManagement.trialDays')}<input type="number" min="0" max="365" value={selected.trialDays} onChange={event => patchSelected({ trialDays: Math.max(0, Math.min(365, Number(event.target.value || 0))) })} style={inputStyle} /></label>
                <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('planManagement.badge')}<input value={selected.badge ?? ''} onChange={event => patchSelected({ badge: event.target.value || null })} style={inputStyle} /></label>
                <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('planManagement.cta')}<input value={selected.cta} onChange={event => patchSelected({ cta: event.target.value })} style={inputStyle} /></label>
              </div>
              <label style={{ display: 'block', marginTop: 14, fontSize: 12, color: 'var(--text-muted)' }}>{t('admin.plans.descriptionLabel')}<textarea value={selected.description} onChange={event => patchSelected({ description: event.target.value })} rows={3} style={{ ...inputStyle, resize: 'vertical' }} /></label>
              <PlanFeatureListEditor values={selected.features} disabled={saving || !canUpdate} onChange={features => patchSelected({ features })} />
              <PlanEntitlementEditor values={selected.entitlements} disabled={saving || !canUpdate} onChange={entitlements => patchSelected({ entitlements })} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 12, color: 'var(--text)' }}><input type="checkbox" checked={selected.active} onChange={event => patchSelected({ active: event.target.checked })} /> {t('planManagement.publiclyActive')}</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 18 }}>
                <Btn variant="primary" onClick={save} disabled={saving || !canUpdate}><Save size={14} aria-hidden="true" />{saving ? t('planManagement.saving') : t('admin.plans.savePlan')}</Btn>
                {!canUpdate && <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{t('planManagement.readOnly')}</span>}
                {saved && <span style={{ color: 'var(--c-success)', fontSize: 12 }}>{t('common.saved')}</span>}
              </div>
            </Card>
          </>
        )}
        <AdminSubscriptionControls canUpdate={canUpdate} />
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  display: 'block', width: '100%', marginTop: 6, boxSizing: 'border-box', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg)', color: 'var(--text)', font: 'inherit', fontSize: 12,
}

const retryButton: React.CSSProperties = {
  border: '1px solid var(--primary)', borderRadius: 7, padding: '7px 10px', background: 'var(--primary)', color: '#fff', font: 'inherit', fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap',
}
