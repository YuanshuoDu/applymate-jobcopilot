'use client'

import React, { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, CalendarDays, Save } from 'lucide-react'
import { apiMutate, useApi } from '@/lib/hooks'
import type { UserIntegrationStatus } from '@/lib/admin/integration-status'
import type { PrivacyPreferences } from '@/lib/types'
import { editablePrivacyPreferences, isPrivacyPreferenceAvailable } from '@/lib/privacy-consent'
import { useAdminPrompt } from './AdminPromptDialog'
import { AdminUserApiKeysPanel } from './AdminUserApiKeysPanel'
import { adminMutationHeaders } from '@/lib/admin/client'

type Detail = {
  user: {
    name: string | null
    email: string
    plan: string
    accountStatus: 'active' | 'suspended'
    location: string | null
    createdAt: string
    jobsCount: number
    resumeExists: boolean
    gmail: { connected: boolean; hasError: boolean }
  }
  applications: {
    count: number
    recent: Array<{ id: number; status: string; mode: string; atsType: string | null; flowUsed: string | null; durationMs: number | null; createdAt: string }>
  }
}

type Override = { id: string; featureKey: string; enabled: boolean; limit: number | null; expiresAt: string | null; reason: string }
type PlanChange = { id: string; fromPlan: string; toPlan: string; reason: string; actorUserId: string; createdAt: string }
type Subscription = { id: string; plan: string; status: 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired'; trialStartsAt: string | null; trialEndsAt: string | null; currentPeriodStart: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; scheduledPlan: string | null; scheduledAt: string | null; version: number; updatedAt: string }

function dateTimeLocal(value: string | null | undefined) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const offset = date.getTimezoneOffset()
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16)
}

function AccountOperations({ userId, user, permissions }: { userId: string; user: Detail['user']; permissions: readonly string[] }) {
  const [status, setStatus] = useState(user.accountStatus)
  const [plan, setPlan] = useState(user.plan)
  const [subscription, setSubscription] = useState<Subscription | null>(null)
  const [subscriptionStatus, setSubscriptionStatus] = useState<Subscription['status']>('active')
  const [trialEndsAt, setTrialEndsAt] = useState('')
  const [currentPeriodEnd, setCurrentPeriodEnd] = useState('')
  const [cancelAtPeriodEnd, setCancelAtPeriodEnd] = useState(false)
  const [overrides, setOverrides] = useState<Override[]>([])
  const [planHistory, setPlanHistory] = useState<PlanChange[]>([])
  const [featureKey, setFeatureKey] = useState('auto_apply')
  const [enabled, setEnabled] = useState(true)
  const [limit, setLimit] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const { request, dialog } = useAdminPrompt()

  useEffect(() => { setStatus(user.accountStatus); setPlan(user.plan) }, [user.accountStatus, user.plan])
  useEffect(() => {
    if (!permissions.includes('users.feature_override')) return
    void fetch(`/api/admin/v1/users/${userId}/feature-overrides`, { cache: 'no-store' }).then(response => response.json()).then(payload => setOverrides(payload.items ?? [])).catch(() => setNotice('Unable to load feature overrides.'))
  }, [permissions, userId])
  useEffect(() => {
    if (!permissions.includes('billing.read')) return
    void fetch(`/api/admin/v1/users/${userId}/plan`, { cache: 'no-store' }).then(response => response.json()).then(payload => {
      setPlanHistory(payload.changes ?? [])
      const next = payload.subscription as Subscription | null | undefined
      setSubscription(next ?? null)
      if (next) {
        setPlan(next.plan)
        setSubscriptionStatus(next.status)
        setTrialEndsAt(dateTimeLocal(next.trialEndsAt))
        setCurrentPeriodEnd(dateTimeLocal(next.currentPeriodEnd))
        setCancelAtPeriodEnd(next.cancelAtPeriodEnd)
      }
    }).catch(() => setNotice('Unable to load plan history.'))
  }, [permissions, userId])

  async function mutate(url: string, body: Record<string, unknown>, message: string) {
    const reason = await request({ title: 'Confirm account operation', label: 'Reason', kind: 'reason', description: 'This action is audited and requires an operational reason.', submitLabel: 'Continue' })
    if (!reason) return
    setBusy(true)
    const response = await fetch(url, { method: 'PATCH', headers: adminMutationHeaders(), body: JSON.stringify({ ...body, reason }) })
    const payload = await response.json().catch(() => null) as { error?: string; item?: Override } | null
    setBusy(false)
    if (!response.ok) { setNotice(payload?.error ?? 'Operation failed.'); return }
    setNotice(message)
    if (payload?.item) setOverrides(current => [...current.filter(item => item.featureKey !== payload.item!.featureKey), payload.item!])
  }

  async function saveSubscription() {
    const reason = await request({ title: 'Save package settings', label: 'Reason', kind: 'reason', description: 'Plan, trial and subscription changes are audited and version checked.', submitLabel: 'Save package settings' })
    if (!reason) return
    setBusy(true)
    try {
      const response = await fetch(`/api/admin/v1/users/${userId}/plan`, { method: 'PATCH', headers: adminMutationHeaders(), body: JSON.stringify({ toPlan: plan, status: subscriptionStatus, trialEndsAt: subscriptionStatus === 'trialing' && trialEndsAt ? new Date(trialEndsAt).toISOString() : null, currentPeriodEnd: currentPeriodEnd ? new Date(currentPeriodEnd).toISOString() : null, cancelAtPeriodEnd, version: subscription?.version, reason }) })
      const payload = await response.json().catch(() => null) as { error?: string; subscription?: Subscription } | null
      if (!response.ok) { setNotice(payload?.error ?? 'Package settings could not be saved.'); return }
      if (payload?.subscription) {
        setSubscription(payload.subscription)
        setSubscriptionStatus(payload.subscription.status)
        setTrialEndsAt(dateTimeLocal(payload.subscription.trialEndsAt))
        setCurrentPeriodEnd(dateTimeLocal(payload.subscription.currentPeriodEnd))
        setCancelAtPeriodEnd(payload.subscription.cancelAtPeriodEnd)
      }
      setNotice('Package settings saved.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Package settings could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  async function removeOverride(item: Override) {
    const reason = await request({ title: 'Remove user permission override', label: 'Reason', kind: 'reason', description: `The user will inherit the ${item.featureKey} permission from their package again.`, submitLabel: 'Remove override' })
    if (!reason) return
    setBusy(true)
    const response = await fetch(`/api/admin/v1/users/${userId}/feature-overrides?featureKey=${encodeURIComponent(item.featureKey)}&reason=${encodeURIComponent(reason)}`, { method: 'DELETE', headers: adminMutationHeaders({ json: false }) })
    const payload = await response.json().catch(() => null) as { error?: string } | null
    setBusy(false)
    if (!response.ok) { setNotice(payload?.error ?? 'Permission override could not be removed.'); return }
    setOverrides(current => current.filter(currentItem => currentItem.featureKey !== item.featureKey))
    setNotice('User permission override removed.')
  }


  const canSuspend = permissions.includes('users.suspend')
  const canRestore = permissions.includes('users.restore')
  const canPlan = permissions.includes('billing.update') && permissions.includes('billing.read')
  const canOverride = permissions.includes('users.feature_override')
  return <><section className="admin-detail-operations"><div className="admin-settings-heading"><div><h2>Account operations</h2><p>Core administrators can manage access, package settings and lifecycle state. Every write is audited.</p></div><span role="status">{notice}</span></div><div className="admin-operation-grid">
    <label>Account state<select value={status} disabled={busy || (status === 'active' ? !canSuspend : !canRestore)} onChange={event => { const next = event.target.value as 'active' | 'suspended'; setStatus(next); void mutate(`/api/admin/v1/users/${userId}/account-state`, { status: next }, next === 'suspended' ? 'Account suspended.' : 'Account restored.') }}><option value="active">Active</option><option value="suspended">Suspended</option></select></label>
    <label>Commercial plan<select value={plan} disabled={busy || !canPlan} onChange={event => setPlan(event.target.value)}><option value="free">Free</option><option value="pro">Pro</option><option value="enterprise">Enterprise</option></select></label>
    {canPlan && <label>Subscription state<select value={subscriptionStatus} disabled={busy} onChange={event => setSubscriptionStatus(event.target.value as Subscription['status'])}><option value="trialing">Trialing</option><option value="active">Active</option><option value="past_due">Past due</option><option value="cancelled">Cancelled</option><option value="expired">Expired</option></select></label>}
    {canPlan && <label>Trial ends<input type="datetime-local" value={trialEndsAt} disabled={busy || subscriptionStatus !== 'trialing'} onChange={event => setTrialEndsAt(event.target.value)} /></label>}
    {canPlan && <label>Current period ends<input type="datetime-local" value={currentPeriodEnd} disabled={busy} onChange={event => setCurrentPeriodEnd(event.target.value)} /></label>}
  </div>{canPlan && <div className="admin-inline-actions"><label className="admin-operation-checkbox"><input type="checkbox" checked={cancelAtPeriodEnd} disabled={busy} onChange={event => setCancelAtPeriodEnd(event.target.checked)} /> Cancel at period end</label><button type="button" className="admin-secondary" disabled={busy} onClick={() => void saveSubscription()}>Save package settings</button></div>}{canOverride && <><h3>User permissions</h3><p className="admin-operation-help">Grant, deny or temporarily limit a user feature independently from the commercial package. Removing an override returns to package permissions.</p><form className="admin-operation-form" onSubmit={event => { event.preventDefault(); void mutate(`/api/admin/v1/users/${userId}/feature-overrides`, { featureKey, enabled, limit: limit ? Number(limit) : null, expiresAt: expiresAt || null }, 'User permission saved.') }}><input value={featureKey} onChange={event => setFeatureKey(event.target.value)} placeholder="Permission key, e.g. auto_apply" required /><label><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /> Granted</label><input type="number" min="0" value={limit} onChange={event => setLimit(event.target.value)} placeholder="Limit" /><input type="datetime-local" value={expiresAt} onChange={event => setExpiresAt(event.target.value)} /><button className="admin-secondary" disabled={busy}>Save permission</button></form><div className="admin-override-list">{overrides.length === 0 ? <span>No user permission overrides.</span> : overrides.map(item => <span key={item.id}>{item.featureKey}: {item.enabled ? 'granted' : 'denied'}{item.limit === null ? '' : ` · limit ${item.limit}`}{item.expiresAt ? ` · expires ${new Date(item.expiresAt).toLocaleDateString()}` : ''}<button type="button" className="admin-chip-remove" disabled={busy} onClick={() => void removeOverride(item)}>Remove</button></span>)}</div></>}{permissions.includes('billing.read') && <section className="admin-detail-history"><h3>Plan change history</h3><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>From</th><th>To</th><th>Reason</th><th>Actor</th><th>Time</th></tr></thead><tbody>{planHistory.length === 0 ? <tr><td colSpan={5}>No plan changes.</td></tr> : planHistory.map(change => <tr key={change.id}><td>{change.fromPlan}</td><td>{change.toPlan}</td><td>{change.reason}</td><td>{change.actorUserId}</td><td>{new Date(change.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div></section>}</section>{dialog}</>
}

type Preferences = {
  targetRoles: string
  targetLocations: string
  salaryExpectation: string
  workAuthorization: string
  openToRelocation: boolean
  notificationPreferences: Record<string, boolean>
  privacyPreferences: PrivacyPreferences
  dataDeletionRequestStatus?: 'requested' | 'processing' | 'completed' | 'cancelled'
}

type SettingsResponse = { user: { preferences: Preferences; integrations: UserIntegrationStatus } }

const notificationLabels: Record<string, string> = {
  apply: 'Application updates', reject: 'Rejections', interview: 'Interview invitations', offer: 'Offer notifications', weekly: 'Weekly summary', followUp: 'Follow-up reminders',
}

const privacyLabels: Record<string, string> = {
  shareUsageData: 'Share anonymous usage data', allowAiTraining: 'Allow AI training', storeCoverLetters: 'Store cover letters',
}

function nextDeletionStatuses(status: Preferences['dataDeletionRequestStatus']) {
  if (status === 'requested') return ['processing', 'cancelled'] as const
  if (status === 'processing') return ['completed', 'cancelled'] as const
  return [] as const
}

function aiStatusLabel(status: UserIntegrationStatus['ai']['providers'][keyof UserIntegrationStatus['ai']['providers']]) {
  if (status.userConfigured) return 'User key'
  if (status.platformConfigured) return 'Platform fallback'
  return 'Not configured'
}

function ToggleList<T extends object>({ labels, values, disabled, onChange, isAvailable }: {
  labels: Record<string, string>
  values: T
  disabled: boolean
  onChange: (key: string, value: boolean) => void
  isAvailable?: (key: string) => boolean
}) {
  return <div className="admin-settings-list">{Object.entries(labels).map(([key, label]) => {
    const available = isAvailable?.(key) ?? true
    return <label key={key} className="admin-settings-toggle"><span>{label}{available ? '' : ' (currently unavailable)'}</span><input type="checkbox" checked={Boolean(values[key as keyof T])} disabled={disabled || !available} onChange={(event) => onChange(key, event.target.checked)} /></label>
  })}</div>
}

function SettingsPanel({ userId, canUpdatePreferences }: { userId: string; canUpdatePreferences: boolean }) {
  const { data, loading, error, refetch } = useApi<SettingsResponse>(`/api/admin/v1/users/${userId}/settings`, { cache: false })
  const [draft, setDraft] = useState<Preferences | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const { request, dialog } = useAdminPrompt()
  const preferences = draft ?? data?.user.preferences
  const integrations = data?.user.integrations
  const deletionStatuses = nextDeletionStatuses(preferences?.dataDeletionRequestStatus)

  function updateGroup(group: 'notificationPreferences' | 'privacyPreferences', key: string, value: boolean) {
    if (!preferences) return
    setDraft({ ...preferences, [group]: { ...preferences[group], [key]: value } })
  }

  async function save() {
    if (!preferences) return
    const reason = await request({ title: 'Save candidate settings', label: 'Reason', kind: 'reason', description: 'The change will be recorded in the admin audit log.', submitLabel: 'Save' })
    if (!reason) return
    setSaving(true)
    setSaveError(null)
    const original = data?.user.preferences
    const result = await apiMutate<SettingsResponse>(`/api/admin/v1/users/${userId}/settings`, 'PATCH', {
      notificationPreferences: preferences.notificationPreferences,
      privacyPreferences: editablePrivacyPreferences(preferences.privacyPreferences),
      reason,
      ...(preferences.dataDeletionRequestStatus && preferences.dataDeletionRequestStatus !== original?.dataDeletionRequestStatus ? { dataDeletionRequestStatus: preferences.dataDeletionRequestStatus } : {}),
    })
    setSaving(false)
    if (result.error) {
      setSaveError(result.error)
      return
    }
    setDraft(result.data?.user.preferences ?? preferences)
    void refetch()
  }

  return <><section className="admin-detail-settings">
    <div className="admin-settings-heading"><div><h2>Candidate settings</h2><p>Notification, privacy and deletion-request settings only. Credentials and documents are excluded.</p></div>{loading && <span>Loading...</span>}</div>
    {error || saveError ? <div className="admin-alert">{error ?? saveError}</div> : null}
    {!preferences && !loading ? <p className="admin-settings-empty">Settings are unavailable for this account.</p> : null}
    {preferences && <>
      <div className="admin-settings-readonly"><span>Target roles: {preferences.targetRoles || 'Not set'}</span><span>Locations: {preferences.targetLocations || 'Not set'}</span><span>Relocation: {preferences.openToRelocation ? 'Open' : 'Not open'}</span></div>
      {integrations && <section className="admin-settings-integrations"><h3>Integration status</h3><div className="admin-settings-status-list"><span>Gmail: {integrations.accounts.gmail ? 'Connected' : 'Not connected'}</span><span>GitHub: {integrations.accounts.github ? 'Connected' : 'Not connected'}</span><span>Adzuna: {integrations.discovery.hasAdzuna ? 'Ready' : 'Not configured'}</span><span>RapidAPI: {integrations.discovery.hasRapidapi ? 'Ready' : 'Not configured'}</span>{Object.entries(integrations.ai.providers).map(([provider, status]) => <span key={provider}>{provider}: {aiStatusLabel(status)}</span>)}</div><p className="admin-settings-integration-note">Only readiness and source labels are shown. API keys, OAuth tokens, documents and mailbox content are excluded.</p></section>}
      <div className="admin-settings-grid">
        <section><h3>Notification preferences</h3><ToggleList labels={notificationLabels} values={preferences.notificationPreferences} disabled={!canUpdatePreferences || saving} onChange={(key, value) => updateGroup('notificationPreferences', key, value)} /></section>
        <section><h3>Privacy preferences</h3><ToggleList labels={privacyLabels} values={preferences.privacyPreferences} disabled={!canUpdatePreferences || saving} onChange={(key, value) => updateGroup('privacyPreferences', key, value)} isAvailable={(key) => isPrivacyPreferenceAvailable(key as 'shareUsageData' | 'allowAiTraining' | 'storeCoverLetters')} /></section>
      </div>
      {preferences.dataDeletionRequestStatus && <label className="admin-settings-deletion">Deletion request<select value={preferences.dataDeletionRequestStatus} disabled={!canUpdatePreferences || saving || deletionStatuses.length === 0} onChange={(event) => setDraft({ ...preferences, dataDeletionRequestStatus: event.target.value as Preferences['dataDeletionRequestStatus'] })}><option value={preferences.dataDeletionRequestStatus}>{preferences.dataDeletionRequestStatus}</option>{deletionStatuses.map(status => <option key={status} value={status}>{status}</option>)}</select></label>}
      {canUpdatePreferences ? <button type="button" className="admin-secondary" onClick={() => void save()} disabled={saving}><Save size={15} />{saving ? 'Saving...' : 'Save settings'}</button> : <p className="admin-settings-readonly-notice">You can view settings but do not have permission to edit them.</p>}
    </>}
  </section>{dialog}</>
}

export function AdminUserDetailPage({ userId, canUpdatePreferences, permissions = [] }: { userId: string; canUpdatePreferences: boolean; permissions?: readonly string[] }) {
  const { data, loading, error } = useApi<Detail>(`/api/admin/v1/users/${userId}`)
  const user = data?.user
  return <div className="admin-page"><header className="admin-header"><div><Link prefetch={false} className="admin-back" href="/admin/users"><ArrowLeft size={16} /> Users</Link><h1>{loading ? 'Loading user...' : user?.name ?? 'User'}</h1><p>Masked account metadata and safe operational history</p></div><div className="admin-header-time"><CalendarDays size={18} /> Internal console</div></header>
    {error ? <div className="admin-alert">{error}</div> : user && <section className="admin-detail"><div className="admin-detail-grid"><section><h2>Account</h2><dl><dt>Email</dt><dd>{user.email}</dd><dt>Plan</dt><dd>{user.plan}</dd><dt>Account state</dt><dd>{user.accountStatus}</dd><dt>Location</dt><dd>{user.location ?? 'Not provided'}</dd><dt>Joined</dt><dd>{new Date(user.createdAt).toLocaleString()}</dd></dl></section><section><h2>Safe status</h2><dl><dt>Jobs</dt><dd>{user.jobsCount}</dd><dt>Resume</dt><dd>{user.resumeExists ? 'On file' : 'Not uploaded'}</dd><dt>Gmail</dt><dd>{user.gmail.connected ? (user.gmail.hasError ? 'Needs attention' : 'Connected') : 'Not connected'}</dd><dt>Applications</dt><dd>{data.applications.count}</dd></dl></section></div><AccountOperations userId={userId} user={user} permissions={permissions} /><AdminUserApiKeysPanel userId={userId} canRevoke={permissions.includes('users.api_keys.revoke')} /><SettingsPanel userId={userId} canUpdatePreferences={canUpdatePreferences} /><section className="admin-detail-history"><h2>Recent application metadata</h2><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Status</th><th>ATS</th><th>Flow</th><th>Mode</th><th>Created</th></tr></thead><tbody>{data.applications.recent.length === 0 ? <tr><td colSpan={5}>No application records.</td></tr> : data.applications.recent.map((item) => <tr key={item.id}><td>{item.status}</td><td>{item.atsType ?? 'unknown'}</td><td>{item.flowUsed ?? 'unknown'}</td><td>{item.mode}</td><td>{new Date(item.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div></section></section>}
  </div>
}
