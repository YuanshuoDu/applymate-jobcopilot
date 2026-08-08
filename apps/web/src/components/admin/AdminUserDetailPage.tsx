'use client'

import React, { useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, CalendarDays, Save } from 'lucide-react'
import { apiMutate, useApi } from '@/lib/hooks'
import type { UserIntegrationStatus } from '@/lib/admin/integration-status'
import type { PrivacyPreferences } from '@/lib/types'
import { editablePrivacyPreferences, isPrivacyPreferenceAvailable } from '@/lib/privacy-consent'

type Detail = {
  user: {
    name: string | null
    email: string
    plan: string
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
  const preferences = draft ?? data?.user.preferences
  const integrations = data?.user.integrations
  const deletionStatuses = nextDeletionStatuses(preferences?.dataDeletionRequestStatus)

  function updateGroup(group: 'notificationPreferences' | 'privacyPreferences', key: string, value: boolean) {
    if (!preferences) return
    setDraft({ ...preferences, [group]: { ...preferences[group], [key]: value } })
  }

  async function save() {
    if (!preferences) return
    const reason = window.prompt('Enter the settings-change reason')?.trim()
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

  return <section className="admin-detail-settings">
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
  </section>
}

export function AdminUserDetailPage({ userId, canUpdatePreferences }: { userId: string; canUpdatePreferences: boolean }) {
  const { data, loading, error } = useApi<Detail>(`/api/admin/v1/users/${userId}`)
  const user = data?.user
  return <div className="admin-page"><header className="admin-header"><div><Link className="admin-back" href="/admin/users"><ArrowLeft size={16} /> Users</Link><h1>{loading ? 'Loading user...' : user?.name ?? 'User'}</h1><p>Masked account metadata and safe operational history</p></div><div className="admin-header-time"><CalendarDays size={18} /> Internal console</div></header>
    {error ? <div className="admin-alert">{error}</div> : user && <section className="admin-detail"><div className="admin-detail-grid"><section><h2>Account</h2><dl><dt>Email</dt><dd>{user.email}</dd><dt>Plan</dt><dd>{user.plan}</dd><dt>Location</dt><dd>{user.location ?? 'Not provided'}</dd><dt>Joined</dt><dd>{new Date(user.createdAt).toLocaleString()}</dd></dl></section><section><h2>Safe status</h2><dl><dt>Jobs</dt><dd>{user.jobsCount}</dd><dt>Resume</dt><dd>{user.resumeExists ? 'On file' : 'Not uploaded'}</dd><dt>Gmail</dt><dd>{user.gmail.connected ? (user.gmail.hasError ? 'Needs attention' : 'Connected') : 'Not connected'}</dd><dt>Applications</dt><dd>{data.applications.count}</dd></dl></section></div><SettingsPanel userId={userId} canUpdatePreferences={canUpdatePreferences} /><section className="admin-detail-history"><h2>Recent application metadata</h2><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Status</th><th>ATS</th><th>Flow</th><th>Mode</th><th>Created</th></tr></thead><tbody>{data.applications.recent.length === 0 ? <tr><td colSpan={5}>No application records.</td></tr> : data.applications.recent.map((item) => <tr key={item.id}><td>{item.status}</td><td>{item.atsType ?? 'unknown'}</td><td>{item.flowUsed ?? 'unknown'}</td><td>{item.mode}</td><td>{new Date(item.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div></section></section>}
  </div>
}
