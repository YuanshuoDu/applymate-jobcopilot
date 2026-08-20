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
import { useI18n } from '@/lib/i18n'
import {
  buildAdminSettingsPatch,
  getDeletionRequestActions,
  getDeletionRequestLabel,
  type DeletionRequestAction,
  type AdminSettingsUser,
} from './admin-users-view-model'

type AdminUsersResponse = { users: AdminSettingsUser[]; total: number; page: number; pageSize: number }

const NOTIFICATION_FIELDS: Array<{ key: keyof NotificationPreferences; labelKey: string }> = [
  { key: 'apply', labelKey: 'adminUsers.autoApplyConfirmations' },
  { key: 'reject', labelKey: 'adminUsers.rejectionNotifications' },
  { key: 'interview', labelKey: 'adminUsers.interviewInvitations' },
  { key: 'offer', labelKey: 'adminUsers.offerNotifications' },
  { key: 'weekly', labelKey: 'adminUsers.weeklySummary' },
  { key: 'followUp', labelKey: 'adminUsers.followUpReminders' },
]

const PRIVACY_FIELDS: Array<{ key: keyof PrivacyPreferences; labelKey: string }> = [
  { key: 'shareUsageData', labelKey: 'adminUsers.shareUsageData' },
  { key: 'allowAiTraining', labelKey: 'adminUsers.allowAiTraining' },
  { key: 'storeCoverLetters', labelKey: 'adminUsers.storeCoverLetters' },
]

function Toggle({ value, onChange, disabled }: { value: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  const { t } = useI18n()
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={value ? t('adminUsers.enabled') : t('adminUsers.disabled')}
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
  const { t } = useI18n()
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
        {user.name ?? t('admin.unnamed')} · {user.plan}
      </div>
    </button>
  )
}

function deletionLabel(user: AdminSettingsUser, t: (key: string) => string): string {
  const status = user.preferences.dataDeletionRequestStatus
  const requestedAt = user.preferences.dataDeletionRequestedAt
  if (!status || !requestedAt) return t('adminUsers.noDeletionRequest')
  const date = requestedAt.slice(0, 10)
  if (status === 'processing') return `${t('adminUsers.deletionProcessing')} ${date})`
  if (status === 'completed') return `${t('adminUsers.deletionCompleted')} ${date}`
  if (status === 'cancelled') return `${t('adminUsers.deletionCancelled')} ${date}`
  return `${t('adminUsers.deletionRequested')} ${date}`
}

export function AdminUsersPage() {
  const { t } = useI18n()
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
      title: t('adminUsers.saveSettings'),
      label: t('adminUsers.settingsReason'),
      kind: 'reason',
      description: t('adminUsers.auditDescription'),
      submitLabel: t('adminUsers.saveSettings'),
    })
    if (reason === null) return
    let patch: ReturnType<typeof buildAdminSettingsPatch>
    try {
      patch = buildAdminSettingsPatch(notifications, privacy, reason)
    } catch (error) {
      toast.error(t('adminUsers.saveFailed'), error instanceof Error ? error.message : t('adminUsers.validReason'))
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
      toast.error(t('adminUsers.saveFailed'), requestError)
      return
    }
    if (response?.user) {
      setUsers(current => current.map(user => user.id === response.user.id ? response.user : user))
    }
    toast.success(t('adminUsers.saved'))
  }

  async function updateDeletionRequestStatus(status: DeletionRequestAction['status']) {
    if (!selectedUser) return
    const reason = await adminPrompt.request({
      title: t('adminUsers.updateDeletion'),
      label: t('adminUsers.workflowReason'),
      kind: 'reason',
      description: t('adminUsers.auditDescription'),
      submitLabel: t('adminUsers.updateRequest'),
    })
    if (reason === null) return
    let patch: ReturnType<typeof buildAdminSettingsPatch>
    try {
      patch = buildAdminSettingsPatch(notifications, privacy, reason, status)
    } catch (error) {
      toast.error(t('adminUsers.updateFailed'), error instanceof Error ? error.message : t('adminUsers.validReason'))
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
      toast.error(t('adminUsers.updateFailed'), requestError)
      return
    }
    if (response?.user) {
      setUsers(current => current.map(user => user.id === response.user.id ? response.user : user))
    }
    toast.success(t('adminUsers.deletionUpdated'))
  }

  const accessError = error?.toLowerCase().includes('admin')
    ? t('adminUsers.restricted')
    : error

  return (
    <div style={{ minHeight: '100%', background: 'var(--bg-tertiary)', overflowY: 'auto' }}>
      <TopBar title={t('adminUsers.title')}>
        <a href="/admin/observability" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-muted)', textDecoration: 'none' }}>
          {t('adminUsers.observability')} <ExternalLink size={12} aria-hidden="true" />
        </a>
        <Btn small variant="ghost" onClick={refetch} disabled={loading}>
          <RefreshCw size={13} aria-hidden="true" /> {t('common.refresh')}
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
                placeholder={t('adminUsers.searchUsers')}
                aria-label={t('adminUsers.searchUsers')}
                style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'var(--text)', fontSize: 12 }}
              />
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{loading ? t('adminUsers.loadingUsers') : `${users.length} ${t('adminUsers.of')} ${data?.total ?? users.length} ${t('adminUsers.users')}`}</div>
          </div>
          <div style={{ maxHeight: 560, overflowY: 'auto' }}>
            {!loading && users.length === 0 && <div style={{ padding: 16, fontSize: 12, color: 'var(--text-muted)' }}>{t('adminUsers.noUsers')}</div>}
            {users.map(user => <UserListItem key={user.id} user={user} selected={user.id === selectedId} onSelect={() => setSelectedId(user.id)} />)}
          </div>
          {(data?.total ?? 0) > (data?.pageSize ?? 50) && <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 10, borderTop: '1px solid var(--border)' }}>
            <Btn small variant="ghost" onClick={() => setPage(current => Math.max(current - 1, 1))} disabled={page <= 1 || loading}>{t('common.previous')}</Btn>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t('adminUsers.page')} {page} {t('adminUsers.of')} {Math.max(1, Math.ceil((data?.total ?? 0) / (data?.pageSize ?? 50)))}</span>
            <Btn small variant="ghost" onClick={() => setPage(current => current + 1)} disabled={page >= Math.ceil((data?.total ?? 0) / (data?.pageSize ?? 50)) || loading}>{t('common.next')}</Btn>
          </div>}
        </Card>

        <Card style={{ padding: 18 }}>
          {!selectedUser ? (
            <div style={{ minHeight: 220, display: 'grid', placeItems: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
              <span>{t('adminUsers.selectUser')}</span>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, paddingBottom: 14, borderBottom: '1px solid var(--border)' }}>
                <ShieldCheck size={19} color="var(--primary)" aria-hidden="true" />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{selectedUser.email}</div>
                  <div style={{ marginTop: 3, fontSize: 11, color: 'var(--text-muted)' }}>{selectedUser.name ?? t('admin.unnamed')} · {selectedUser.plan}</div>
                  <div style={{ marginTop: 5, fontSize: 10, color: 'var(--text-muted)' }}>{deletionLabel(selectedUser, t)}</div>
                </div>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{t('adminUsers.secretsHidden')}</span>
              </div>

              <section style={{ marginTop: 16, padding: 12, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-secondary)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 11 }}>
                  <span style={{ color: 'var(--text-muted)' }}>{t('admin.plan')}</span>
                  <strong>{selectedUser.plan}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 7, fontSize: 11 }}>
                  <span style={{ color: 'var(--text-muted)' }}>{t('adminUsers.gdprRequest')}</span>
                  <span>{deletionLabel(selectedUser, t)}</span>
                </div>
                <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-muted)' }}>{t('adminUsers.auditStatus')}</div>
                {deletionActions.length > 0 && <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 10 }}>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t('adminUsers.requestWorkflow')}</span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6 }}>
                    {deletionActions.map(action => <Btn
                      key={action.status}
                      small
                      variant={action.status === 'cancelled' ? 'ghost' : 'primary'}
                      disabled={saving}
                      onClick={() => void updateDeletionRequestStatus(action.status)}
                    >{action.status === 'processing' ? t('adminUsers.startProcessing') : action.status === 'completed' ? t('adminUsers.recordCompletion') : t('adminUsers.cancelRequest')}</Btn>)}
                  </div>
                </div>}
              </section>

              {selectedUser.integrations && (
                <section style={{ marginTop: 16, padding: 12, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-secondary)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                    <h2 style={{ margin: 0, fontSize: 13 }}>{t('adminUsers.integrationHealth')}</h2>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t('adminUsers.presenceOnly')}</span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    <span style={{ fontSize: 10, padding: '3px 7px', borderRadius: 999, background: selectedUser.integrations.discovery.hasAdzuna ? 'rgba(5,150,105,0.10)' : 'var(--bg)', color: selectedUser.integrations.discovery.hasAdzuna ? 'var(--c-success)' : 'var(--text-muted)' }}>Adzuna {selectedUser.integrations.discovery.hasAdzuna ? selectedUser.integrations.discovery.adzunaSource : t('adminUsers.notReady')}</span>
                    <span style={{ fontSize: 10, padding: '3px 7px', borderRadius: 999, background: selectedUser.integrations.discovery.hasRapidapi ? 'rgba(5,150,105,0.10)' : 'var(--bg)', color: selectedUser.integrations.discovery.hasRapidapi ? 'var(--c-success)' : 'var(--text-muted)' }}>RapidAPI {selectedUser.integrations.discovery.hasRapidapi ? selectedUser.integrations.discovery.rapidapiSource : t('adminUsers.notReady')}</span>
                    <span style={{ fontSize: 10, padding: '3px 7px', borderRadius: 999, background: selectedUser.integrations.accounts.gmail ? 'rgba(5,150,105,0.10)' : 'var(--bg)', color: selectedUser.integrations.accounts.gmail ? 'var(--c-success)' : 'var(--text-muted)' }}>Gmail {selectedUser.integrations.accounts.gmail ? t('adminUsers.connected') : t('adminUsers.notConnected')}</span>
                    <span style={{ fontSize: 10, padding: '3px 7px', borderRadius: 999, background: selectedUser.integrations.accounts.github ? 'rgba(5,150,105,0.10)' : 'var(--bg)', color: selectedUser.integrations.accounts.github ? 'var(--c-success)' : 'var(--text-muted)' }}>GitHub {selectedUser.integrations.accounts.github ? t('adminUsers.connected') : t('adminUsers.notConnected')}</span>
                  </div>
                  <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-muted)' }}>
                    {t('adminUsers.aiOverrides')}: {selectedUser.integrations.ai.featureOverrides} · {t('adminUsers.effectiveProviders')}: {Object.entries(selectedUser.integrations.ai.providers).filter(([, value]) => value.effective).map(([provider]) => provider).join(', ') || t('adminUsers.none')}
                  </div>
                </section>
              )}

              <section style={{ marginTop: 16 }}>
                <h2 style={{ margin: '0 0 8px', fontSize: 13 }}>{t('adminUsers.candidatePreferences')} <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>({t('adminUsers.readOnly')})</span></h2>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
                  {([
                    ['targetRoles', 'adminUsers.targetRoles'],
                    ['targetLocations', 'adminUsers.targetLocations'],
                    ['salaryExpectation', 'adminUsers.salaryExpectation'],
                    ['workAuthorization', 'adminUsers.workAuthorization'],
                  ] as const).map(([key, label]) => (
                    <div key={key} style={{ display: 'grid', gap: 4, fontSize: 10, color: 'var(--text-muted)' }}>
                      <span>{t(label)}</span>
                      <span style={{ minHeight: 30, padding: '7px 8px', border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg-secondary)', color: 'var(--text)', fontSize: 11 }}>{selectedUser.preferences[key] || t('adminUsers.notSet')}</span>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11 }}>
                  <span>{t('adminUsers.openToRelocation')}</span>
                  <span>{selectedUser.preferences.openToRelocation ? t('common.yes') : t('common.no')}</span>
                </div>
              </section>

              <section style={{ marginTop: 16 }}>
                <h2 style={{ margin: '0 0 8px', fontSize: 13 }}>{t('adminUsers.notificationPreferences')}</h2>
                {NOTIFICATION_FIELDS.map(field => (
                  <div key={field.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ fontSize: 12 }}>{t(field.labelKey)}</span>
                    <Toggle value={notifications[field.key]} disabled={saving} onChange={value => setNotifications(current => ({ ...current, [field.key]: value }))} />
                  </div>
                ))}
              </section>

              <section style={{ marginTop: 16 }}>
                <h2 style={{ margin: '0 0 8px', fontSize: 13 }}>{t('adminUsers.privacyPreferences')}</h2>
                {PRIVACY_FIELDS.map(field => (
                  <div key={field.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ fontSize: 12, color: isPrivacyPreferenceAvailable(field.key) ? 'var(--text)' : 'var(--text-muted)' }}>
                      {t(field.labelKey)}{isPrivacyPreferenceAvailable(field.key) ? '' : ` (${t('adminUsers.currentlyUnavailable')})`}
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
                  <Save size={13} aria-hidden="true" /> {saving ? t('adminUsers.saving') : t('adminUsers.saveSettings')}
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
