'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { ExternalLink, RefreshCw, Save, Search, ShieldCheck } from 'lucide-react'
import { TopBar } from '@/components/layout/TopBar'
import { Btn, Card, useToast } from '@/components/ui'
import { apiMutate, useApi } from '@/lib/hooks'
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  DEFAULT_PRIVACY_PREFERENCES,
  readNotificationPreferences,
  readPrivacyPreferences,
} from '@/lib/settings-preferences'
import type { NotificationPreferences, PrivacyPreferences } from '@/lib/types'
import { isPrivacyPreferenceAvailable } from '@/lib/privacy-consent'
import { useAdminPrompt } from '@/components/admin/AdminPromptDialog'
import {
  buildAdminSettingsPatch,
  getDeletionRequestActions,
  getDeletionRequestLabel,
  type DeletionRequestAction,
  type AdminSettingsUser,
} from './admin-users-view-model'

type AdminUsersResponse = { users: AdminSettingsUser[]; total: number; page: number; pageSize: number }

const NOTIFICATION_FIELDS: Array<{ key: keyof NotificationPreferences; label: string }> = [
  { key: 'apply', label: 'Auto-apply confirmations' },
  { key: 'reject', label: 'Rejection notifications' },
  { key: 'interview', label: 'Interview invitations' },
  { key: 'offer', label: 'Offer notifications' },
  { key: 'weekly', label: 'Weekly summary' },
  { key: 'followUp', label: 'Follow-up reminders' },
]

const PRIVACY_FIELDS: Array<{ key: keyof PrivacyPreferences; label: string }> = [
  { key: 'shareUsageData', label: 'Share anonymous usage data' },
  { key: 'allowAiTraining', label: 'Allow AI training' },
  { key: 'storeCoverLetters', label: 'Store cover letters' },
]

function Toggle({ value, onChange, disabled }: { value: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={value ? 'Enabled' : 'Disabled'}
      disabled={disabled}
      onClick={() => onChange(!value)}
      style={{
        width: 34, height: 20, padding: 0, border: 0, borderRadius: 10,
        background: value ? 'var(--primary)' : 'var(--border)',
        position: 'relative', cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1, flexShrink: 0,
      }}
    >
      <span style={{
        position: 'absolute', top: 3, left: value ? 17 : 3,
        width: 14, height: 14, borderRadius: '50%', background: '#fff',
        transition: 'left 0.15s',
      }} />
    </button>
  )
}

function UserListItem({ user, selected, onSelect }: { user: AdminSettingsUser; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        width: '100%', textAlign: 'left', padding: '11px 12px', border: 0,
        borderBottom: '1px solid var(--border)', background: selected ? 'rgba(79,70,229,0.09)' : 'transparent',
        color: 'var(--text)', cursor: 'pointer', fontFamily: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: selected ? 'var(--primary)' : 'var(--border)', flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.email}</span>
      </div>
      <div style={{ marginTop: 4, paddingLeft: 16, fontSize: 10, color: 'var(--text-muted)' }}>
        {user.name ?? 'Unnamed'} · {user.plan}
      </div>
    </button>
  )
}

export function AdminUsersPage() {
  const toast = useToast()
  const adminPrompt = useAdminPrompt()
  const [searchInput, setSearchInput] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const usersUrl = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), limit: '50' })
    if (query) params.set('q', query)
    return `/api/admin/v1/users?${params.toString()}`
  }, [page, query])
  const { data, loading, error, refetch } = useApi<AdminUsersResponse>(usersUrl, { cache: false })
  const [users, setUsers] = useState<AdminSettingsUser[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [notifications, setNotifications] = useState<NotificationPreferences>(DEFAULT_NOTIFICATION_PREFERENCES)
  const [privacy, setPrivacy] = useState<PrivacyPreferences>(DEFAULT_PRIVACY_PREFERENCES)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1)
      setQuery(searchInput.trim().slice(0, 120))
    }, 250)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    if (!data) return
    setUsers(data.users ?? [])
    setSelectedId(current => current && data.users.some(user => user.id === current) ? current : data.users[0]?.id ?? null)
  }, [data])

  const selectedUser = users.find(user => user.id === selectedId) ?? null
  const deletionActions = selectedUser ? getDeletionRequestActions(selectedUser) : []

  useEffect(() => {
    if (!selectedUser) return
    setNotifications(readNotificationPreferences(selectedUser.preferences))
    setPrivacy(readPrivacyPreferences(selectedUser.preferences))
  }, [selectedUser])

  async function saveSettings() {
    if (!selectedUser) return
    const reason = await adminPrompt.request({
      title: 'Save user settings',
      label: 'Reason for this settings change',
      kind: 'reason',
      description: 'This reason is stored in the administrator audit trail.',
      submitLabel: 'Save settings',
    })
    if (reason === null) return
    let patch: ReturnType<typeof buildAdminSettingsPatch>
    try {
      patch = buildAdminSettingsPatch(notifications, privacy, reason)
    } catch (error) {
      toast.error('Could not save user settings', error instanceof Error ? error.message : 'A valid settings-change reason is required')
      return
    }
    setSaving(true)
    const { data: response, error: requestError } = await apiMutate<{ user: AdminSettingsUser }>(
      `/api/admin/v1/users/${encodeURIComponent(selectedUser.id)}/settings`,
      'PATCH',
      patch,
    )
    setSaving(false)
    if (requestError) {
      toast.error('Could not save user settings', requestError)
      return
    }
    if (response?.user) {
      setUsers(current => current.map(user => user.id === response.user.id ? response.user : user))
    }
    toast.success('User settings saved')
  }

  async function updateDeletionRequestStatus(status: DeletionRequestAction['status']) {
    if (!selectedUser) return
    const reason = await adminPrompt.request({
      title: 'Update deletion request',
      label: 'Reason for this workflow change',
      kind: 'reason',
      description: 'This reason is stored in the administrator audit trail.',
      submitLabel: 'Update request',
    })
    if (reason === null) return
    let patch: ReturnType<typeof buildAdminSettingsPatch>
    try {
      patch = buildAdminSettingsPatch(notifications, privacy, reason, status)
    } catch (error) {
      toast.error('Could not update deletion request', error instanceof Error ? error.message : 'A valid settings-change reason is required')
      return
    }
    setSaving(true)
    const { data: response, error: requestError } = await apiMutate<{ user: AdminSettingsUser }>(
      `/api/admin/v1/users/${encodeURIComponent(selectedUser.id)}/settings`,
      'PATCH',
      patch,
    )
    setSaving(false)
    if (requestError) {
      toast.error('Could not update deletion request', requestError)
      return
    }
    if (response?.user) {
      setUsers(current => current.map(user => user.id === response.user.id ? response.user : user))
    }
    toast.success('Deletion request updated')
  }

  const accessError = error?.toLowerCase().includes('admin')
    ? 'This page is restricted to explicitly allow-listed administrators.'
    : error

  return (
    <div style={{ minHeight: '100%', background: 'var(--bg-tertiary)', overflowY: 'auto' }}>
      <TopBar title="Admin · User settings">
        <a href="/admin/observability" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-muted)', textDecoration: 'none' }}>
          Observability <ExternalLink size={12} aria-hidden="true" />
        </a>
        <Btn small variant="ghost" onClick={refetch} disabled={loading}>
          <RefreshCw size={13} aria-hidden="true" /> Refresh
        </Btn>
      </TopBar>

      <main style={{ padding: 20, display: 'grid', gridTemplateColumns: 'minmax(240px, 320px) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
        {accessError && (
          <Card style={{ gridColumn: '1 / -1', padding: 14, color: 'var(--c-danger)', borderColor: 'rgba(220,38,38,0.25)' }}>
            {accessError}
          </Card>
        )}

        <Card style={{ overflow: 'hidden' }}>
          <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 9 }}>
              <Search size={14} aria-hidden="true" color="var(--text-muted)" />
              <input
                value={searchInput}
                onChange={event => setSearchInput(event.target.value)}
                placeholder="Search users"
                aria-label="Search users"
                style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'var(--text)', fontSize: 12 }}
              />
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{loading ? 'Loading users…' : `${users.length} of ${data?.total ?? users.length} users`}</div>
          </div>
          <div style={{ maxHeight: 560, overflowY: 'auto' }}>
            {!loading && users.length === 0 && <div style={{ padding: 16, fontSize: 12, color: 'var(--text-muted)' }}>No users found.</div>}
            {users.map(user => <UserListItem key={user.id} user={user} selected={user.id === selectedId} onSelect={() => setSelectedId(user.id)} />)}
          </div>
          {(data?.total ?? 0) > (data?.pageSize ?? 50) && <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 10, borderTop: '1px solid var(--border)' }}>
            <Btn small variant="ghost" onClick={() => setPage(current => Math.max(current - 1, 1))} disabled={page <= 1 || loading}>Previous</Btn>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Page {page} of {Math.max(1, Math.ceil((data?.total ?? 0) / (data?.pageSize ?? 50)))}</span>
            <Btn small variant="ghost" onClick={() => setPage(current => current + 1)} disabled={page >= Math.ceil((data?.total ?? 0) / (data?.pageSize ?? 50)) || loading}>Next</Btn>
          </div>}
        </Card>

        <Card style={{ padding: 18 }}>
          {!selectedUser ? (
            <div style={{ minHeight: 220, display: 'grid', placeItems: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
              <span>Select a user to inspect settings.</span>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, paddingBottom: 14, borderBottom: '1px solid var(--border)' }}>
                <ShieldCheck size={19} color="var(--primary)" aria-hidden="true" />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{selectedUser.email}</div>
                  <div style={{ marginTop: 3, fontSize: 11, color: 'var(--text-muted)' }}>{selectedUser.name ?? 'Unnamed'} · {selectedUser.plan}</div>
                  <div style={{ marginTop: 5, fontSize: 10, color: 'var(--text-muted)' }}>{getDeletionRequestLabel(selectedUser)}</div>
                </div>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Secrets hidden</span>
              </div>

              <section style={{ marginTop: 16, padding: 12, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-secondary)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 11 }}>
                  <span style={{ color: 'var(--text-muted)' }}>Plan</span>
                  <strong>{selectedUser.plan}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 7, fontSize: 11 }}>
                  <span style={{ color: 'var(--text-muted)' }}>GDPR request</span>
                  <span>{getDeletionRequestLabel(selectedUser)}</span>
                </div>
                <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-muted)' }}>Status changes are recorded in the user audit trail.</div>
                {deletionActions.length > 0 && <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 10 }}>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Request workflow</span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6 }}>
                    {deletionActions.map(action => <Btn
                      key={action.status}
                      small
                      variant={action.status === 'cancelled' ? 'ghost' : 'primary'}
                      disabled={saving}
                      onClick={() => void updateDeletionRequestStatus(action.status)}
                    >{action.label}</Btn>)}
                  </div>
                </div>}
              </section>

              {selectedUser.integrations && (
                <section style={{ marginTop: 16, padding: 12, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-secondary)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                    <h2 style={{ margin: 0, fontSize: 13 }}>Integration health</h2>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>presence only</span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    <span style={{ fontSize: 10, padding: '3px 7px', borderRadius: 999, background: selectedUser.integrations.discovery.hasAdzuna ? 'rgba(5,150,105,0.10)' : 'var(--bg)', color: selectedUser.integrations.discovery.hasAdzuna ? 'var(--c-success)' : 'var(--text-muted)' }}>Adzuna {selectedUser.integrations.discovery.hasAdzuna ? selectedUser.integrations.discovery.adzunaSource : 'not ready'}</span>
                    <span style={{ fontSize: 10, padding: '3px 7px', borderRadius: 999, background: selectedUser.integrations.discovery.hasRapidapi ? 'rgba(5,150,105,0.10)' : 'var(--bg)', color: selectedUser.integrations.discovery.hasRapidapi ? 'var(--c-success)' : 'var(--text-muted)' }}>RapidAPI {selectedUser.integrations.discovery.hasRapidapi ? selectedUser.integrations.discovery.rapidapiSource : 'not ready'}</span>
                    <span style={{ fontSize: 10, padding: '3px 7px', borderRadius: 999, background: selectedUser.integrations.accounts.gmail ? 'rgba(5,150,105,0.10)' : 'var(--bg)', color: selectedUser.integrations.accounts.gmail ? 'var(--c-success)' : 'var(--text-muted)' }}>Gmail {selectedUser.integrations.accounts.gmail ? 'connected' : 'not connected'}</span>
                    <span style={{ fontSize: 10, padding: '3px 7px', borderRadius: 999, background: selectedUser.integrations.accounts.github ? 'rgba(5,150,105,0.10)' : 'var(--bg)', color: selectedUser.integrations.accounts.github ? 'var(--c-success)' : 'var(--text-muted)' }}>GitHub {selectedUser.integrations.accounts.github ? 'connected' : 'not connected'}</span>
                  </div>
                  <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-muted)' }}>
                    AI overrides: {selectedUser.integrations.ai.featureOverrides} · effective providers: {Object.entries(selectedUser.integrations.ai.providers).filter(([, value]) => value.effective).map(([provider]) => provider).join(', ') || 'none'}
                  </div>
                </section>
              )}

              <section style={{ marginTop: 16 }}>
                <h2 style={{ margin: '0 0 8px', fontSize: 13 }}>Candidate job preferences <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>(read-only)</span></h2>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
                  {([
                    ['targetRoles', 'Target roles'],
                    ['targetLocations', 'Target locations'],
                    ['salaryExpectation', 'Salary expectation'],
                    ['workAuthorization', 'Work authorisation'],
                  ] as const).map(([key, label]) => (
                    <div key={key} style={{ display: 'grid', gap: 4, fontSize: 10, color: 'var(--text-muted)' }}>
                      <span>{label}</span>
                      <span style={{ minHeight: 30, padding: '7px 8px', border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg-secondary)', color: 'var(--text)', fontSize: 11 }}>{selectedUser.preferences[key] || 'Not set'}</span>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11 }}>
                  <span>Open to relocation</span>
                  <span>{selectedUser.preferences.openToRelocation ? 'Yes' : 'No'}</span>
                </div>
              </section>

              <section style={{ marginTop: 16 }}>
                <h2 style={{ margin: '0 0 8px', fontSize: 13 }}>Notification preferences</h2>
                {NOTIFICATION_FIELDS.map(field => (
                  <div key={field.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ fontSize: 12 }}>{field.label}</span>
                    <Toggle value={notifications[field.key]} disabled={saving} onChange={value => setNotifications(current => ({ ...current, [field.key]: value }))} />
                  </div>
                ))}
              </section>

              <section style={{ marginTop: 16 }}>
                <h2 style={{ margin: '0 0 8px', fontSize: 13 }}>Privacy preferences</h2>
                {PRIVACY_FIELDS.map(field => (
                  <div key={field.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ fontSize: 12, color: isPrivacyPreferenceAvailable(field.key) ? 'var(--text)' : 'var(--text-muted)' }}>
                      {field.label}{isPrivacyPreferenceAvailable(field.key) ? '' : ' (currently unavailable)'}
                    </span>
                    <Toggle
                      value={privacy[field.key]}
                      disabled={saving || !isPrivacyPreferenceAvailable(field.key)}
                      onChange={value => setPrivacy(current => ({ ...current, [field.key]: value }))}
                    />
                  </div>
                ))}
              </section>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                <Btn variant="primary" onClick={saveSettings} disabled={saving}>
                  <Save size={13} aria-hidden="true" /> {saving ? 'Saving…' : 'Save settings'}
                </Btn>
              </div>
            </>
          )}
        </Card>
      </main>
      {adminPrompt.dialog}
    </div>
  )
}
