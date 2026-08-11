'use client'

import React, { useState, useEffect, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { signOut } from 'next-auth/react'
import { TopBar } from '@/components/layout/TopBar'
import { Btn, Card, useToast, useConfirm, UserAvatar } from '@/components/ui'
import type { NotificationPreferences, PrivacyPreferences, UserProfile, UserPreferences } from '@/lib/types'
import { useApi, apiMutate } from '@/lib/hooks'
import { useI18n, LANGUAGES, type Lang } from '@/lib/i18n'
import { useTheme, type ThemeMode } from '@/components/ThemeProvider'
import {
  MODEL_CATALOGUE, PROVIDER_LABELS, APPLYMATE_BACKING, APPLYMATE_LABEL,
  type Provider, type AiConfig, type FeatureId, type UserAiSettings,
} from '@/lib/model-router-client'
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  DEFAULT_PRIVACY_PREFERENCES,
  hasActiveDeletionRequest,
  readNotificationPreferences,
  readPrivacyPreferences,
} from '@/lib/settings-preferences'
import {
  discoveryKeyClearPatch,
  EXTENSION_SETUP_HREF,
  billingSupportHref,
  billingStatusText,
  gmailOAuthStartHref,
  hasPendingSecretClear,
  matchesEmailConfirmation,
  settingsExportFilename,
  secretInputValue,
  settingsTabFromHref,
  settingsTabHref,
  discoveryKeyStatusText,
  hasSavedDiscoveryKey,
  isOAuthProviderAvailable,
  type DiscoveryStatusView,
  type OAuthProviderAvailability,
  type SettingsTab,
} from './settings-view-model'
import { customConfigError, hasIncompleteCustomConfig } from './ai-settings-view-model'
import type { PublicPlan } from '@/lib/plan-catalogue-shared'
import { hasUsageAnalyticsConsentChanged, isPrivacyPreferenceAvailable } from '@/lib/privacy-consent'

// ── Static data ───────────────────────────────────────────────────────────────

const CONNECTED_ACCOUNTS = [
  { id: 'gmail',    name: 'Gmail',    icon: '✉',  color: 'var(--c-danger)', connected: false, available: false, account: null as string | null, disconnectable: true, legacy: false, desc: 'AI email detection, auto-labeling & follow-up' },
  { id: 'linkedin', name: 'LinkedIn', icon: 'in', color: 'var(--primary)', connected: false, available: false, account: null as string | null, disconnectable: true, legacy: false, desc: 'No LinkedIn OAuth connector is configured' },
  { id: 'indeed',   name: 'Indeed',   icon: 'I',  color: '#003A9B', connected: false, available: false, account: null as string | null, disconnectable: true, legacy: false, desc: 'Indeed search uses public sources, not account login' },
  { id: 'github',   name: 'GitHub',   icon: '⌥',  color: '#24292f', connected: false, available: false, account: null as string | null, disconnectable: true, legacy: false, desc: 'Pull CV data from repos'       },
]

// ── UI helpers ────────────────────────────────────────────────────────────────

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card style={{ overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{title}</span>
      </div>
      <div style={{ padding: '4px 16px 16px' }}>{children}</div>
    </Card>
  )
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="settings-field-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0, minWidth: 130 }}>{label}</span>
      <div className="settings-field-control" style={{ display: 'flex', justifyContent: 'flex-start', flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  )
}

function Input({ value, onChange, type = 'text', placeholder, readOnly, style = {} }: {
  value?: string
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void
  type?: string
  placeholder?: string
  readOnly?: boolean
  style?: React.CSSProperties
}) {
  return (
    <input
      type={type} value={value} onChange={onChange} placeholder={placeholder} readOnly={readOnly}
      style={{ padding: '7px 10px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 8, background: readOnly ? 'var(--bg-secondary)' : 'var(--bg)', color: 'var(--text)', outline: 'none', width: '100%', maxWidth: 260, opacity: readOnly ? 0.65 : 1, transition: 'border-color 0.15s, box-shadow 0.15s', ...style }}
      onFocus={e => { if (!readOnly) { e.currentTarget.style.borderColor = 'rgba(var(--primary-rgb,79,70,229),0.5)'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(var(--primary-rgb,79,70,229),0.10)' } }}
      onBlur={e => { e.currentTarget.style.borderColor = ''; e.currentTarget.style.boxShadow = '' }}
    />
  )
}

function Toggle({ label, value, onChange, disabled = false }: { label?: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label ?? (value ? 'Enabled' : 'Disabled')}
      disabled={disabled}
      onClick={() => onChange(!value)}
      style={{ width: 32, height: 18, border: 0, padding: 0, borderRadius: 9, background: value ? 'var(--primary)' : 'var(--border)', cursor: disabled ? 'not-allowed' : 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0, opacity: disabled ? 0.55 : 1 }}
    >
      <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#fff', position: 'absolute', top: 2, left: value ? 16 : 2, transition: 'left 0.2s' }} />
    </button>
  )
}

// ── SettingsPage ──────────────────────────────────────────────────────────────

type Tab = SettingsTab

function initialSettingsTab(): Tab {
  if (typeof window === 'undefined') return 'profile'
  return settingsTabFromHref(window.location.href)
}

const THEME_OPTIONS: { mode: ThemeMode; icon: string }[] = [
  { mode: 'light', icon: '☀' },
  { mode: 'system', icon: '💻' },
  { mode: 'dark', icon: '🌙' },
]

export function SettingsPage() {
  const router = useRouter()
  const toast = useToast()
  const { lang, t, setLang } = useI18n()
  const { mode, setMode } = useTheme()
  const [confirm, ConfirmDialog] = useConfirm()

  // Load user profile
  const { data: user, loading: userLoading, error: userError, refetch: refetchUser } = useApi<UserProfile>('/api/me')
  const { data: billingData, loading: billingLoading, error: billingError } = useApi<{ plans: PublicPlan[] }>('/api/plans')

  // Profile form state (editable fields)
  const [name,     setName    ] = useState('')
  const [phone,    setPhone   ] = useState('')
  const [location, setLocation] = useState('')
  const [linkedin, setLinkedin] = useState('')
  const [github,   setGithub  ] = useState('')
  const [saving,   setSaving  ] = useState(false)
  const [avatar,   setAvatar  ] = useState<string | null>(null)
  const [avatarSaving, setAvatarSaving] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement>(null)

  // Job preferences state
  const [prefRoles,       setPrefRoles]       = useState('')
  const [prefLocations,   setPrefLocations]   = useState('')
  const [prefSalary,      setPrefSalary]      = useState('')
  const [prefVisa,        setPrefVisa]        = useState('EU citizen / no visa required')
  const [prefRelocate,    setPrefRelocate]    = useState(true)

  // Sync all fields from API
  useEffect(() => {
    if (!user) return
    setName(user.name ?? '')
    setPhone(user.phone ?? '')
    setLocation(user.location ?? '')
    setLinkedin(user.linkedin ?? '')
    setGithub(user.github ?? '')
    setAvatar(user.image ?? null)
    if (user.preferences) {
      setPrefRoles(user.preferences.targetRoles ?? '')
      setPrefLocations(user.preferences.targetLocations ?? '')
      setPrefSalary(user.preferences.salaryExpectation ?? '')
      setPrefVisa(user.preferences.workAuthorization ?? 'EU citizen / no visa required')
      setPrefRelocate(user.preferences.openToRelocation ?? true)
      setNotifs(readNotificationPreferences(user.preferences))
      setPrivacy(readPrivacyPreferences(user.preferences))
      setDeletionRequested(hasActiveDeletionRequest(user.preferences))
    } else {
      setNotifs(DEFAULT_NOTIFICATION_PREFERENCES)
      setPrivacy(DEFAULT_PRIVACY_PREFERENCES)
      setDeletionRequested(false)
    }
  }, [user])

  const [activeTab,      setActiveTab     ] = useState<Tab>(initialSettingsTab)
  const [notifs,         setNotifs        ] = useState<NotificationPreferences>(DEFAULT_NOTIFICATION_PREFERENCES)
  const [privacy,        setPrivacy       ] = useState<PrivacyPreferences>(DEFAULT_PRIVACY_PREFERENCES)
  const [preferenceSaving, setPreferenceSaving] = useState<'notifications' | 'privacy' | null>(null)
  const [deletionRequested, setDeletionRequested] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [showCancelModal,   setShowCancelModal]   = useState(false)
  const [connectedProviders, setConnectedProviders] = useState<{ provider: string; account: string; disconnectable?: boolean; legacy?: boolean }[]>([])
  const [oauthProviders, setOauthProviders] = useState<OAuthProviderAvailability>({ gmail: false, github: false })
  const [gmailHealth, setGmailHealth] = useState<{ hasGmail: boolean; reason: string | null; scopes?: string; gmailError?: string }>({ hasGmail: true, reason: null })
  const [accountAction, setAccountAction] = useState<string | null>(null)
  const [accountsError, setAccountsError] = useState<string | null>(null)
  const [accountsLoading, setAccountsLoading] = useState(false)

  useEffect(() => {
    const handlePopState = () => setActiveTab(settingsTabFromHref(window.location.href))
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    if (activeTab !== 'accounts' || typeof window === 'undefined') return
    const url = new URL(window.location.href)
    const githubError = url.searchParams.get('githubError')
    const githubAuth = url.searchParams.get('githubAuth')
    const gmailError = url.searchParams.get('gmailError')
    if (githubError) toast.error('GitHub connection failed', githubError.replaceAll('_', ' '))
    else if (githubAuth === '1') toast.success('GitHub connected')
    if (gmailError) toast.error('Gmail connection failed', gmailError.replaceAll('_', ' '))
    if (githubError || githubAuth || gmailError) {
      url.searchParams.delete('githubError')
      url.searchParams.delete('githubAuth')
      url.searchParams.delete('gmailError')
      window.history.replaceState({}, '', url.toString())
    }
  }, [activeTab, toast])

  // OAuth state is only shown on the Accounts tab. Deferring these requests
  // keeps the common Profile/Appearance visits responsive.
  useEffect(() => {
    if (activeTab !== 'accounts') return
    let cancelled = false
    setAccountsLoading(true)
    setAccountsError(null)
    Promise.all([
      fetch('/api/me/accounts').then(async response => {
        const data = await response.json().catch(() => null)
        if (!response.ok) throw new Error(data?.error ?? 'Could not load connected accounts')
        return data
      }),
      fetch('/api/gmail/check').then(async response => {
        const data = await response.json().catch(() => null)
        if (!response.ok) throw new Error(data?.error ?? 'Could not verify Gmail access')
        return data
      }),
      fetch('/api/me/integrations').then(async response => {
        const data = await response.json().catch(() => null)
        if (!response.ok) throw new Error(data?.error ?? 'Could not verify available integrations')
        return data
      }),
    ])
      .then(([accountsData, gmailData, integrationsData]) => {
        if (cancelled) return
        setConnectedProviders(Array.isArray(accountsData?.accounts) ? accountsData.accounts : [])
        setGmailHealth({ hasGmail: Boolean(gmailData?.hasGmail), reason: gmailData?.reason ?? null, scopes: gmailData?.scopes, gmailError: gmailData?.gmailError })
        setOauthProviders({
          gmail: Boolean(integrationsData?.providers?.gmail),
          github: Boolean(integrationsData?.providers?.github),
        })
      })
      .catch(error => {
        if (!cancelled) setAccountsError(error instanceof Error ? error.message : 'Could not load connected accounts')
      })
      .finally(() => { if (!cancelled) setAccountsLoading(false) })
    return () => { cancelled = true }
  }, [activeTab])

  // Merge real connections with static config
  const accounts = useMemo(() => {
    return CONNECTED_ACCOUNTS.map(acc => {
      const conn = connectedProviders.find(c => c.provider === acc.id)
      const available = isOAuthProviderAvailable(acc.id, oauthProviders)
      const desc = !available && (acc.id === 'gmail' || acc.id === 'github')
        ? `${acc.name} OAuth is not configured by the platform`
        : acc.desc
      return conn
        ? { ...acc, available, desc, connected: true, account: conn.account, disconnectable: conn.disconnectable !== false, legacy: conn.legacy }
        : { ...acc, available, desc }
    })
  }, [connectedProviders, oauthProviders])

  // Password change state
  const [passwordCur,  setPasswordCur]  = useState('')
  const [passwordNew,  setPasswordNew]  = useState('')
  const [passwordConf, setPasswordConf] = useState('')
  const [pwSaving,     setPwSaving]     = useState(false)

  const TABS: { id: Tab; label: string }[] = [
    { id: 'profile',  label: t('settings.profile')  },
    { id: 'appearance', label: t('settings.appearance') },
    { id: 'accounts', label: t('settings.accounts') },
    { id: 'apiKeys',  label: 'Keys & connections'   },
    { id: 'billing',  label: t('settings.billing')  },
    { id: 'notifs',   label: t('settings.notifs')   },
    { id: 'privacy',  label: t('settings.privacy')  },
  ]

  const planLabel = billingData?.plans.find(plan => plan.key === user?.plan)?.name
    ?? (user?.plan === 'pro' ? 'Pro' : user?.plan === 'enterprise' ? 'Team' : 'Free')
  const currentPlan = billingData?.plans.find(plan => plan.key === user?.plan)
  const currentPlanId = user?.plan ?? 'free'
  const billingStatus = billingStatusText(currentPlan?.interval, user?.plan)

  async function refreshConnectedAccounts() {
    const response = await fetch('/api/me/accounts')
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new Error(data?.error ?? 'Could not load connected accounts')
    setConnectedProviders(Array.isArray(data?.accounts) ? data.accounts : [])
  }

  async function disconnectAccount(provider: string, name: string) {
    setAccountAction(`disconnect:${provider}`)
    const { error } = await apiMutate('/api/me/accounts', 'DELETE', { provider })
    if (error) {
      toast.error(`${name} disconnect failed`, error)
    } else {
      try {
        await refreshConnectedAccounts()
      } catch (refreshError) {
        setAccountsError(refreshError instanceof Error ? refreshError.message : 'Could not refresh connected accounts')
      }
      if (provider === 'gmail') {
        setGmailHealth({ hasGmail: false, reason: 'disconnected' })
        window.open('https://myaccount.google.com/permissions', '_blank', 'noopener,noreferrer')
        toast.info('Gmail disconnected', 'Visit Google permissions to fully revoke access')
      } else {
        toast.success(`${name} disconnected`)
      }
    }
    setAccountAction(null)
  }

  async function repairGmailAccess() {
    setAccountAction('repair:gmail')
    const { error } = await apiMutate('/api/me/accounts', 'DELETE', { provider: 'gmail' })
    if (error) {
      toast.error('Could not reset Gmail access', error)
      setAccountAction(null)
      return
    }
    window.location.assign(gmailOAuthStartHref(true))
  }

  async function connectGithub() {
    setAccountAction('connect:github')
    try {
      const returnTo = encodeURIComponent('/?page=settings&tab=accounts')
      window.location.assign(`/api/github/oauth/start?returnTo=${returnTo}`)
    } catch (error) {
      toast.error('GitHub connection failed', error instanceof Error ? error.message : 'Could not start GitHub OAuth')
    } finally {
      setAccountAction(null)
    }
  }

  async function saveProfile() {
    setSaving(true)
    const preferences: UserPreferences = {
      targetRoles: prefRoles,
      targetLocations: prefLocations,
      salaryExpectation: prefSalary,
      workAuthorization: prefVisa,
      openToRelocation: prefRelocate,
    }
    const { error } = await apiMutate('/api/me', 'PATCH', {
      name, phone, location, linkedin, github, preferences,
    })
    setSaving(false)
    if (error) toast.error('Error', error)
    else       toast.success('Profile saved')
  }

  function selectTab(tab: Tab) {
    setActiveTab(tab)
    if (typeof window !== 'undefined') {
      window.history.replaceState({}, '', settingsTabHref(tab, window.location.href))
    }
  }

  async function persistNotifications(next: NotificationPreferences) {
    const previous = notifs
    setNotifs(next)
    setPreferenceSaving('notifications')
    const { error } = await apiMutate('/api/me', 'PATCH', { preferences: { notificationPreferences: next } })
    setPreferenceSaving(null)
    if (error) {
      setNotifs(previous)
      toast.error('Notification settings failed', error)
    }
  }

  async function persistPrivacy(next: PrivacyPreferences) {
    const previous = privacy
    setPrivacy(next)
    setPreferenceSaving('privacy')
    const { error } = await apiMutate('/api/me', 'PATCH', { preferences: { privacyPreferences: next } })
    setPreferenceSaving(null)
    if (error) {
      setPrivacy(previous)
      toast.error('Privacy settings failed', error)
    } else if (hasUsageAnalyticsConsentChanged(previous, next)) {
      router.refresh()
    }
  }

  async function handleAvatarChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      toast.error('Invalid image', 'Choose a PNG, JPEG, WebP, or GIF file')
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error('Image too large', 'Avatar images must be 2 MiB or smaller')
      return
    }

    const reader = new FileReader()
    reader.onerror = () => toast.error('Upload failed', 'The image could not be read')
    reader.onload = async () => {
      if (typeof reader.result !== 'string') {
        toast.error('Upload failed', 'The image could not be read')
        return
      }
      const previous = avatar
      setAvatar(reader.result)
      setAvatarSaving(true)
      const { error } = await apiMutate('/api/me', 'PATCH', { image: reader.result })
      setAvatarSaving(false)
      if (error) {
        setAvatar(previous)
        toast.error('Upload failed', error)
      } else {
        toast.success('Profile photo updated')
        void refetchUser()
      }
    }
    reader.readAsDataURL(file)
  }

  async function downloadUserData() {
    setExporting(true)
    try {
      const response = await fetch('/api/me/persona/export', { cache: 'no-store' })
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error(data?.error ?? 'Could not export your data')
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = settingsExportFilename(new Date())
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      toast.success('Data export ready')
    } catch (error) {
      toast.error('Export failed', error instanceof Error ? error.message : 'Could not export your data')
    } finally {
      setExporting(false)
    }
  }

  async function requestDataDeletion() {
    const approved = await confirm({
      title: 'Request data deletion?',
      message: 'We will record your GDPR deletion request and contact you about the retention timeline.',
      danger: true,
      confirmLabel: 'Submit request',
    })
    if (!approved) return
    const { error } = await apiMutate('/api/me/deletion-request', 'POST')
    if (error) toast.error('Request failed', error)
    else {
      setDeletionRequested(true)
      toast.success('Deletion request submitted', 'Support will follow up with the retention timeline')
    }
  }

  function openBillingSupport(action: string) {
    const address = process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? 'support@applymate.site'
    window.location.assign(billingSupportHref(address, action))
  }

  const TAB_ICONS: Record<Tab, string> = {
    profile:  '👤',
    appearance: '🎨',
    accounts: '🔗',
    apiKeys:  '🔑',
    billing:  '💳',
    notifs:   '🔔',
    privacy:  '🔒',
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-tertiary)' }}>
      <ConfirmDialog />
      <TopBar title={t('settings.title')}>
        {activeTab === 'profile' && (
          <Btn variant="primary" onClick={saveProfile} disabled={saving || userLoading || Boolean(userError) || !user}>
            {saving ? t('settings.saving') : t('settings.save')}
          </Btn>
        )}
      </TopBar>

      <div className="settings-workspace" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* ── Settings sidebar ── */}
        <div className="settings-sidebar" style={{
          width: 192, flexShrink: 0,
          background: 'var(--glass-sidebar)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderRight: '1px solid var(--border)',
          padding: '10px 8px',
          overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 2,
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-subtle)', letterSpacing: '0.08em', textTransform: 'uppercase', padding: '6px 10px 8px' }}>Settings</div>
          {TABS.map(tab => {
            const active = activeTab === tab.id
            return (
              <button key={tab.id} type="button" onClick={() => selectTab(tab.id)} style={{
                display: 'flex', alignItems: 'center', gap: 9,
                width: '100%', padding: '8px 10px', borderRadius: 8,
                border: 'none', cursor: 'pointer', textAlign: 'left',
                background: active ? 'rgba(var(--primary-rgb,79,70,229),0.10)' : 'transparent',
                color:      active ? 'var(--primary)'    : 'var(--text-muted)',
                fontWeight: active ? 600                  : 400,
                fontSize: 13,
                transition: 'all 0.14s',
                position: 'relative',
              }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'rgba(var(--primary-rgb,79,70,229),0.05)' }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
              >
                {/* Active left-border indicator */}
                {active && (
                  <div style={{ position: 'absolute', left: 0, top: '20%', bottom: '20%', width: 3, borderRadius: '0 2px 2px 0', background: 'var(--primary)' }} />
                )}
                <span style={{ fontSize: 15, opacity: active ? 1 : 0.6 }}>{TAB_ICONS[tab.id]}</span>
                <span>{tab.label}</span>
              </button>
            )
          })}
        </div>

        {/* ── Content area ── */}
        <div className="settings-content" style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* ── Profile ── */}
          {activeTab === 'profile' && (
            <>
              <div className="settings-profile-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))', gap: 16, alignItems: 'start' }}>
                <SettingsSection title={t('settings.personalInfo')}>
                  {userLoading ? (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '12px 0' }}>Loading...</div>
                  ) : userError ? (
                    <div style={{ padding: '12px 0', fontSize: 12, color: 'var(--c-danger)' }}>
                      Could not load your profile: {userError}
                    </div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12, paddingBottom: 12, borderBottom: '0.5px solid var(--border)' }}>
                        <UserAvatar src={avatar ?? user?.image} name={user?.name} email={user?.email} size={56} />
                        <div>
                          <input ref={avatarInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={handleAvatarChange} style={{ display: 'none' }} />
                          <Btn small variant="ghost" disabled={avatarSaving} onClick={() => avatarInputRef.current?.click()}>
                            {avatarSaving ? 'Uploading...' : 'Upload photo'}
                          </Btn>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>JPG, PNG up to 2MB</div>
                        </div>
                      </div>

                      <FieldRow label="Full name"><Input value={name} onChange={e => setName(e.target.value)} placeholder="Your name" /></FieldRow>
                      <FieldRow label="Email"><Input value={user?.email ?? ''} readOnly placeholder="email@example.com" /></FieldRow>
                      <FieldRow label="Phone"><Input type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+1 555 000 0000" /></FieldRow>
                      <FieldRow label="Location"><Input value={location} onChange={e => setLocation(e.target.value)} placeholder="City, Country" /></FieldRow>
                      <FieldRow label="LinkedIn"><Input value={linkedin} onChange={e => setLinkedin(e.target.value)} placeholder="linkedin.com/in/you" /></FieldRow>
                      <FieldRow label="GitHub"><Input value={github} onChange={e => setGithub(e.target.value)} placeholder="github.com/you" /></FieldRow>
                    </>
                  )}
                </SettingsSection>

                <SettingsSection title={t('settings.jobPrefs')}>
                  <FieldRow label="Target roles">    <Input value={prefRoles}     onChange={e => setPrefRoles(e.target.value)}     placeholder="Backend Engineer, SWE" /></FieldRow>
                  <FieldRow label="Target locations"><Input value={prefLocations} onChange={e => setPrefLocations(e.target.value)} placeholder="Amsterdam, Berlin, Remote" /></FieldRow>
                  <FieldRow label="Salary expectation"><Input value={prefSalary}   onChange={e => setPrefSalary(e.target.value)}    placeholder="EUR65,000 - EUR90,000" /></FieldRow>
                  <FieldRow label="Work authorisation">
                    <select value={prefVisa} onChange={e => setPrefVisa(e.target.value)} style={{ padding: '6px 10px', fontSize: 12, border: '0.5px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)', outline: 'none', maxWidth: 260, width: '100%' }}>
                      <option>EU citizen / no visa required</option>
                      <option>Requires sponsorship</option>
                      <option>Open work permit</option>
                    </select>
                  </FieldRow>
                  <FieldRow label="Open to relocation"><Toggle label="Open to relocation" value={prefRelocate} onChange={setPrefRelocate} /></FieldRow>
                </SettingsSection>

                <SettingsSection title={t('settings.password')}>
                  <FieldRow label="Current password">
                    <Input type="password" value={passwordCur}  onChange={e => setPasswordCur(e.target.value)}  placeholder="Password" />
                  </FieldRow>
                  <FieldRow label="New password">
                    <Input type="password" value={passwordNew}  onChange={e => setPasswordNew(e.target.value)}  placeholder="At least 8 characters" />
                  </FieldRow>
                  <FieldRow label="Confirm password">
                    <Input type="password" value={passwordConf} onChange={e => setPasswordConf(e.target.value)} placeholder="Repeat new password" />
                  </FieldRow>
                  <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
                    <Btn variant="ghost" disabled={pwSaving} onClick={async () => {
                      if (!passwordCur || !passwordNew) { toast.info('Enter current and new password'); return }
                      if (passwordNew !== passwordConf) { toast.error('Mismatch', 'New password and confirmation do not match'); return }
                      if (passwordNew.length < 8) { toast.error('Too short', 'Password must be at least 8 characters'); return }
                      setPwSaving(true)
                      const { error } = await apiMutate('/api/me/password', 'PATCH', { currentPassword: passwordCur, newPassword: passwordNew })
                      setPwSaving(false)
                      if (error) { toast.error('Password change failed', error) }
                      else {
                        toast.success('Password updated', 'Sign in again to continue')
                        await signOut({ callbackUrl: '/login?passwordChanged=1' })
                      }
                    }}>{pwSaving ? 'Updating...' : 'Update password'}</Btn>
                  </div>
                </SettingsSection>

                <SettingsSection title={t('settings.wizard')}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '10px 0 14px', lineHeight: 1.7 }}>
                    Re-run onboarding to update goals, profile, job directions, and resume preferences.
                  </div>
                  <Btn variant="ghost" onClick={async () => {
                    const { error } = await apiMutate('/api/me/onboarding', 'PATCH', { reset: true })
                    if (!error) {
                      toast.success('Onboarding reset', 'Reload the page to restart the setup wizard')
                    } else {
                      toast.error('Failed', error)
                    }
                  }}>
                    Restart Setup Wizard
                  </Btn>
                </SettingsSection>
              </div>
            </>
          )}

          {/* ── Appearance & language ── */}
          {activeTab === 'appearance' && (
            <SettingsSection title={t('settings.appearance')}>
              <FieldRow label={t('settings.theme')}>
                <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 9, overflow: 'hidden', background: 'var(--bg-secondary)' }}>
                  {THEME_OPTIONS.map(option => {
                    const selected = mode === option.mode
                    return (
                      <button key={option.mode} type="button" onClick={() => setMode(option.mode)} style={{ minWidth: 88, padding: '7px 10px', border: 'none', borderRight: option.mode === 'dark' ? 'none' : '1px solid var(--border)', cursor: 'pointer', background: selected ? 'rgba(79,70,229,0.14)' : 'transparent', color: selected ? 'var(--primary)' : 'var(--text-muted)', fontFamily: 'inherit', fontSize: 12, fontWeight: selected ? 600 : 400 }}>
                        {option.icon} {t(`theme.${option.mode}`)}
                      </button>
                    )
                  })}
                </div>
              </FieldRow>
              <FieldRow label={t('lang.label')}>
                <select value={lang} onChange={event => setLang(event.target.value as Lang)} style={{ minWidth: 210, padding: '7px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }}>
                  {LANGUAGES.map(language => <option key={language.value} value={language.value}>{language.flag} {language.native}</option>)}
                </select>
              </FieldRow>
            </SettingsSection>
          )}

          {/* ── Keys & connections ── */}
          {activeTab === 'apiKeys' && <KeyManagementSettings />}

          {/* ── Accounts ── */}
          {activeTab === 'accounts' && (
            <>
            <SettingsSection title={t('settings.connAccounts')}>
              {accountsError && (
                <div style={{ margin: '8px 0 12px', padding: '9px 10px', borderRadius: 7, background: 'rgba(220,38,38,0.08)', color: 'var(--c-danger)', fontSize: 11 }}>
                  {accountsError}
                </div>
              )}
              {accountsLoading && (
                <div style={{ margin: '8px 0 12px', fontSize: 11, color: 'var(--text-muted)' }}>Checking connected accounts…</div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {accounts.map(acc => {
                  const isGmail = acc.id === 'gmail'
                  const gmailNeedsFix = isGmail && acc.connected && !gmailHealth.hasGmail
                  return (
                    <div key={acc.id} style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', padding: 14, background: 'var(--bg-secondary)', borderRadius: 10, border: gmailNeedsFix ? '1px solid rgba(163,45,45,0.25)' : '0.5px solid var(--border)' }}>
                      <div style={{ width: 36, height: 36, borderRadius: 8, background: `${acc.color}18`, color: acc.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, flexShrink: 0 }}>
                        {acc.icon}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                          {acc.name}
                          {gmailNeedsFix && (
                            <span style={{ fontSize: 9, background: 'rgba(220,38,38,0.12)', color: 'var(--c-danger)', borderRadius: 999, padding: '1px 6px' }}>Needs fix</span>
                          )}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                          {acc.connected
                            ? gmailNeedsFix
                              ? <span>Gmail API access failed. Token scopes: <code style={{ fontSize: 9, background: 'var(--bg-tertiary)', padding: '1px 4px', borderRadius: 3 }}>{gmailHealth.scopes || '(none)'}</code></span>
                              : acc.account
                            : acc.desc}
                        </div>
                        {gmailNeedsFix && gmailHealth.gmailError && (
                          <div style={{ fontSize: 9, color: 'var(--c-danger)', marginTop: 4, wordBreak: 'break-all', opacity: 0.7 }}>
                            {gmailHealth.gmailError}
                          </div>
                        )}
                      </div>
                      {acc.connected ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {gmailNeedsFix ? (
                               <Btn small variant="primary" disabled={accountsLoading || accountAction !== null} onClick={() => void repairGmailAccess()}>
                               {accountAction === 'repair:gmail' ? 'Resetting...' : 'Fix Gmail Access'}
                             </Btn>
                           ) : acc.disconnectable === false ? (
                             <Btn small variant="primary" disabled={accountsLoading || accountAction !== null} onClick={() => window.location.assign(gmailOAuthStartHref(true))}>
                               Re-link Gmail
                             </Btn>
                           ) : (
                             <span style={{ fontSize: 10, color: 'var(--c-success)', background: 'rgba(5,150,105,0.12)', borderRadius: 999, padding: '2px 8px' }}>● Connected</span>
                           )}
                            {acc.disconnectable !== false && (
                              <Btn small variant="danger" disabled={accountsLoading || accountAction !== null} onClick={() => void disconnectAccount(acc.id, acc.name)}>
                                {accountAction === `disconnect:${acc.id}` ? 'Disconnecting...' : 'Disconnect'}
                              </Btn>
                            )}
                        </div>
                      ) : !acc.available ? (
                         <span title={acc.desc}><Btn small variant="ghost" disabled>Unavailable</Btn></span>
                      ) : (
                         <Btn small variant="primary" disabled={accountsLoading || accountAction !== null} onClick={() => {
                           if (isGmail) {
                             window.location.assign(gmailOAuthStartHref())
                          } else if (acc.id === 'github') {
                            void connectGithub()
                          }
                        }}>Connect</Btn>
                      )}
                    </div>
                  )
                })}
              </div>
            </SettingsSection>

            {/* ── Chrome Extension ── */}
            <SettingsSection title="Chrome 扩展">
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: 14, background: 'var(--bg-secondary)', borderRadius: 10, border: '0.5px solid var(--border)', marginTop: 4 }}>
                {/* Chrome puzzle icon */}
                <div style={{ width: 36, height: 36, borderRadius: 8, background: 'rgba(79,70,229,0.12)', color: 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/><line x1="17.5" y1="15" x2="9" y2="15"/>
                  </svg>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', marginBottom: 2 }}>ApplyMate AI for Chrome</div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>在 LinkedIn、Indeed 等求职网站上一键保存职位、自动填表、查看简历匹配分</div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end', flexShrink: 0 }}>
                  <a
                    href={EXTENSION_SETUP_HREF}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5,
                      padding: '5px 12px', borderRadius: 7, fontSize: 11, fontWeight: 600,
                      background: 'var(--primary)', color: '#fff', textDecoration: 'none',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    安装扩展
                  </a>
                  <a
                    href="https://github.com/YuanshuoDu/applymate-jobcopilot"
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: 10, color: 'var(--text-muted)', textDecoration: 'none' }}
                  >
                    查看使用说明 →
                  </a>
                </div>
              </div>
            </SettingsSection>
            </>
          )}

          {/* ── Billing ── */}
          {activeTab === 'billing' && (
            <>
              <SettingsSection title={t('settings.currentPlan')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{planLabel} Plan</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      {billingStatus.detail}
                    </div>
                  </div>
                  <span style={{ marginLeft: 'auto', fontSize: 10, background: 'rgba(79,70,229,0.12)', color: 'var(--primary)', borderRadius: 999, padding: '3px 10px', fontWeight: 500 }}>{billingStatus.label}</span>
                </div>
                <Btn variant="ghost" onClick={() => openBillingSupport('manage billing')}>Contact billing support</Btn>
              </SettingsSection>

              {billingLoading && !billingData && <Card style={{ padding: 16, color: 'var(--text-muted)', fontSize: 12 }}>Loading plans…</Card>}
              {billingError && !billingData && <Card style={{ padding: 16, color: 'var(--c-danger)', fontSize: 12 }}>{billingError}</Card>}
              {billingData && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 200px), 1fr))', gap: 12 }}>
                {billingData.plans.map(plan => {
                  const isCurrent = currentPlanId === plan.key
                  const canCancel = isCurrent && user?.plan !== 'free'
                  return (
                    <Card key={plan.key} style={{ padding: 16, border: isCurrent ? '1.5px solid var(--primary)' : '0.5px solid var(--border)', background: isCurrent ? 'rgba(79,70,229,0.03)' : 'var(--bg)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                        <span style={{ fontSize: 13, fontWeight: 500 }}>{plan.name}</span>
                        {isCurrent && <span style={{ fontSize: 10, background: 'rgba(79,70,229,0.12)', color: 'var(--primary)', borderRadius: 999, padding: '2px 7px' }}>Current</span>}
                      </div>
                      <div style={{ marginBottom: 12 }}>
                        <span style={{ fontSize: 22, fontWeight: 500 }}>{plan.price}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}> / {plan.interval === 'forever' ? 'forever' : plan.interval}</span>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 14 }}>
                        {plan.features.map(f => (
                          <div key={f} style={{ display: 'flex', gap: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                            <span style={{ color: 'var(--c-success)', flexShrink: 0 }}>✓</span>{f}
                          </div>
                        ))}
                      </div>
                      <Btn variant={isCurrent ? 'ghost' : 'primary'} disabled={isCurrent && !canCancel} style={{ width: '100%', justifyContent: 'center' }}
                        onClick={() => canCancel ? setShowCancelModal(true) : openBillingSupport(plan.key === 'free' ? 'downgrade to Free' : `upgrade to ${plan.name}`)}>
                        {isCurrent ? canCancel ? 'Cancel plan' : 'Current plan' : plan.key === 'free' ? 'Downgrade' : 'Upgrade'}
                      </Btn>
                    </Card>
                  )
                })}
              </div>}
            </>
          )}

          {/* ── Notifications ── */}
          {activeTab === 'notifs' && (
            <SettingsSection title={t('settings.notifPrefs')}>
              {([
                { key: 'apply',     label: 'Auto-apply confirmation', sub: 'When agent submits an application' },
                { key: 'reject',    label: 'Rejection notifications',  sub: 'When you receive a rejection'     },
                { key: 'interview', label: 'Interview invitations',    sub: 'Calendar invite + reminder'       },
                { key: 'offer',     label: 'Offer notifications',      sub: 'When an offer email arrives'      },
                { key: 'weekly',    label: 'Weekly summary email',     sub: 'Every Monday morning'             },
                { key: 'followUp',  label: 'Follow-up reminders',      sub: "When it's time to follow up"     },
              ] as { key: keyof typeof notifs; label: string; sub: string }[]).map(n => (
                <div key={n.key} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '12px 0', borderBottom: '0.5px solid var(--border)' }}>
                  <div>
                    <div style={{ fontSize: 12 }}>{n.label}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{n.sub}</div>
                  </div>
                  <Toggle label={n.label} value={notifs[n.key]} disabled={preferenceSaving === 'notifications'} onChange={v => void persistNotifications({ ...notifs, [n.key]: v })} />
                </div>
              ))}
            </SettingsSection>
          )}

          {/* ── Privacy ── */}
          {activeTab === 'privacy' && (
            <>
              <SettingsSection title={t('settings.dataPrivacy')}>
                {([
                  { key: 'shareUsageData', label: 'Share anonymous usage data',          sub: 'Helps us improve ApplyMate'         },
                  { key: 'allowAiTraining', label: 'Allow AI training on your CVs',       sub: 'Currently unavailable until a training pipeline is approved' },
                  { key: 'storeCoverLetters', label: 'Retain generated cover letters', sub: 'Temporary material is removed after submission when disabled' },
                ] as Array<{ key: keyof PrivacyPreferences; label: string; sub: string }>).map(item => (
                  <div key={item.key} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '12px 0', borderBottom: '0.5px solid var(--border)' }}>
                    <div>
                      <div style={{ fontSize: 12 }}>{item.label}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{item.sub}</div>
                    </div>
                    <Toggle
                      label={item.label}
                      value={privacy[item.key]}
                      disabled={preferenceSaving === 'privacy' || !isPrivacyPreferenceAvailable(item.key)}
                      onChange={value => void persistPrivacy({ ...privacy, [item.key]: value })}
                    />
                  </div>
                ))}
                <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                  <Btn variant="ghost" disabled={exporting} onClick={() => void downloadUserData()}>{exporting ? 'Preparing export...' : 'Download my data'}</Btn>
                  <Btn variant="ghost" disabled={deletionRequested} onClick={() => void requestDataDeletion()}>{deletionRequested ? 'Deletion requested' : 'Request data deletion'}</Btn>
                </div>
                {deletionRequested && <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-muted)' }}>Your request is recorded. Support will follow up with the retention timeline.</div>}
              </SettingsSection>

              <Card style={{ padding: 16, border: '0.5px solid rgba(163,45,45,0.3)', background: 'rgba(163,45,45,0.03)' }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--c-danger)', marginBottom: 8 }}>Danger Zone</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
                  Once you delete your account, there is no going back. All your data — jobs, resumes, cover letters, settings — will be permanently removed.
                </div>
                <Btn variant="danger" onClick={async () => {
                  const ok = await confirm({
                    title: 'Delete your account?',
                    message: `This will permanently erase all your data. To confirm, type your email "${user?.email ?? 'your email'}" in the next step.`,
                    danger: true,
                    confirmLabel: 'I understand, continue',
                    cancelLabel: 'Cancel',
                  })
                  if (!ok) return
                  // Second confirmation: user must type their email
                  const typed = prompt(`Type your email to confirm deletion: ${user?.email ?? ''}`)
                  if (!typed || !user?.email || !matchesEmailConfirmation(typed, user.email)) {
                    toast.warning('Cancelled', 'Email did not match — account preserved')
                    return
                  }
                  const { error } = await apiMutate('/api/me/delete', 'DELETE', { confirmation: typed })
                  if (error) {
                    toast.error('Deletion failed', error)
                  } else {
                    toast.success('Account deleted', 'Redirecting…')
                    setTimeout(() => window.location.replace('/login'), 1500)
                  }
                }}>Delete my account</Btn>
              </Card>
            </>
          )}

        </div>
      </div>

      {/* Cancel plan modal */}
      {showCancelModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) setShowCancelModal(false) }}>
          <Card style={{ width: 380, padding: 24 }}>
            <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 8 }}>Cancel {planLabel} plan?</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 20, lineHeight: 1.7 }}>
              You&apos;ll lose access to all paid features at the end of your current billing period.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn variant="ghost"  style={{ flex: 1, justifyContent: 'center' }} onClick={() => setShowCancelModal(false)}>Keep plan</Btn>
              <Btn variant="danger" style={{ flex: 1, justifyContent: 'center' }} onClick={() => { setShowCancelModal(false); openBillingSupport(`cancel ${planLabel} plan`) }}>Contact support</Btn>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}

// ── API Keys Settings ─────────────────────────────────────────────────────────

type ApiKeyStatus = DiscoveryStatusView & { hasAdzuna: boolean; hasRapidapi: boolean }

type DiscoveryTestStatus = 'idle' | 'testing' | 'ok' | { error: string }

function KeyManagementSettings() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <SettingsSection title="Keys & connections">
        <div style={{ padding: '10px 0 2px', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.65 }}>
          Keep every credential in one place. <strong style={{ color: 'var(--text)' }}>AI model keys</strong> power resume parsing, tailoring, and writing. <strong style={{ color: 'var(--text)' }}>Job discovery keys</strong> only fetch job listings and use your own provider quota.
        </div>
      </SettingsSection>
      <AiModelSettings />
      <ApiKeysSettings />
    </div>
  )
}

function ApiKeysSettings() {
  const toast = useToast()
  const [status, setStatus] = useState<ApiKeyStatus>({ hasAdzuna: false, hasRapidapi: false })
  const [adzunaAppId, setAdzunaAppId] = useState('')
  const [adzunaAppKey, setAdzunaAppKey] = useState('')
  const [rapidapiKey, setRapidapiKey] = useState('')
  const [visible, setVisible] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [keyClearing, setKeyClearing] = useState<'adzuna' | 'rapidapi' | null>(null)
  const [tests, setTests] = useState<Record<'adzuna' | 'rapidapi', DiscoveryTestStatus>>({ adzuna: 'idle', rapidapi: 'idle' })

  useEffect(() => {
    fetch('/api/me/api-keys')
      .then(async response => {
        const data = await response.json().catch(() => null) as (ApiKeyStatus & { error?: string }) | null
        if (!response.ok) throw new Error(data?.error ?? 'Could not load discovery key status')
        setStatus({
          hasAdzuna: Boolean(data?.hasAdzuna),
          hasRapidapi: Boolean(data?.hasRapidapi),
          userHasAdzuna: Boolean(data?.userHasAdzuna),
          userHasRapidapi: Boolean(data?.userHasRapidapi),
          adzunaSource: data?.adzunaSource,
          rapidapiSource: data?.rapidapiSource,
          needsAdzunaPair: Boolean(data?.needsAdzunaPair),
        })
      })
      .catch(error => setLoadError(error instanceof Error ? error.message : 'Could not load discovery key status'))
      .finally(() => setLoading(false))
  }, [])

  function toggleVisible(key: string) {
    setVisible(prev => ({ ...prev, [key]: !prev[key] }))
  }

  async function saveKeys() {
    const body: Record<string, string> = {}
    if (adzunaAppId.trim()) body.adzunaAppId = adzunaAppId.trim()
    if (adzunaAppKey.trim()) body.adzunaAppKey = adzunaAppKey.trim()
    if (rapidapiKey.trim()) body.rapidapiKey = rapidapiKey.trim()

    if (Object.keys(body).length === 0) {
      toast.info('Enter at least one key to save')
      return
    }

    setSaving(true)
    const { data, error } = await apiMutate<ApiKeyStatus>('/api/me/api-keys', 'POST', body)
    setSaving(false)
    if (error) {
      toast.error('Save failed', error)
      return
    }
    if (data) setStatus(data)
    setAdzunaAppId('')
    setAdzunaAppKey('')
    setRapidapiKey('')
    setTests({ adzuna: 'idle', rapidapi: 'idle' })
    toast.success('Job discovery keys saved', 'The next search will use complete user credentials before any platform fallback')
  }

  async function clearKey(provider: 'adzuna' | 'rapidapi') {
    setKeyClearing(provider)
    const { data, error } = await apiMutate<ApiKeyStatus>('/api/me/api-keys', 'POST', discoveryKeyClearPatch(provider))
    setKeyClearing(null)
    if (error) {
      toast.error('Could not clear discovery key', error)
      return
    }
    if (data) setStatus(data)
    setTests(prev => ({ ...prev, [provider]: 'idle' }))
    if (provider === 'adzuna') {
      setAdzunaAppId('')
      setAdzunaAppKey('')
    } else {
      setRapidapiKey('')
    }
    toast.success(`${provider === 'adzuna' ? 'Adzuna' : 'RapidAPI'} key cleared`)
  }

  async function testConnection(provider: 'adzuna' | 'rapidapi') {
    setTests(prev => ({ ...prev, [provider]: 'testing' }))
    try {
      const res = await fetch('/api/me/api-keys', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test', provider }),
      })
      const data = await res.json()
      setTests(prev => ({ ...prev, [provider]: data.ok ? 'ok' : { error: data.error ?? 'Connection failed' } }))
    } catch {
      setTests(prev => ({ ...prev, [provider]: { error: 'Network error — try again' } }))
    }
  }

  function SecretField({ id, label, value, onChange, saved }: {
    id: string
    label: string
    value: string
    onChange: (v: string) => void
    saved?: boolean
  }) {
    const isVisible = Boolean(visible[id])
    return (
      <FieldRow label={label}>
        <div style={{ display: 'flex', gap: 8, width: '100%', maxWidth: 420 }}>
          <Input
            type={isVisible ? 'text' : 'password'}
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder={saved ? 'Saved — paste a new value to replace it' : `Paste your ${label}`}
            style={{ maxWidth: 'none' }}
          />
          <button
            type="button"
            onClick={() => toggleVisible(id)}
            style={{ width: 52, borderRadius: 8, border: '0.5px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12 }}
            title={isVisible ? 'Hide key' : 'Show key'}>
            {isVisible ? 'Hide' : 'Show'}
          </button>
        </div>
      </FieldRow>
    )
  }

  if (loading) return <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>Loading API key status...</div>
  if (loadError) return <div style={{ padding: 14, color: 'var(--c-danger)', fontSize: 12, background: 'rgba(220,38,38,0.08)', borderRadius: 8 }}>{loadError}</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <SettingsSection title="Job discovery APIs">
        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, padding: '10px 0 4px' }}>
          These keys only search job boards. They do not run AI features or parse your resume. Save first, then test the provider; saved values stay masked.
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '8px 0 4px' }}>
          <span style={{ fontSize: 10, borderRadius: 999, padding: '2px 8px', color: status.hasAdzuna ? 'var(--c-success)' : status.needsAdzunaPair ? 'var(--c-danger)' : 'var(--text-muted)', background: status.hasAdzuna ? 'rgba(5,150,105,0.10)' : status.needsAdzunaPair ? 'rgba(220,38,38,0.10)' : 'var(--bg-secondary)' }}>
            Adzuna {discoveryKeyStatusText(status, 'adzuna')}
          </span>
          <span style={{ fontSize: 10, borderRadius: 999, padding: '2px 8px', color: status.hasRapidapi ? 'var(--c-success)' : 'var(--text-muted)', background: status.hasRapidapi ? 'rgba(5,150,105,0.10)' : 'var(--bg-secondary)' }}>
            RapidAPI {discoveryKeyStatusText(status, 'rapidapi')}
          </span>
        </div>
        <div style={{ display: 'grid', gap: 10, padding: '8px 0 4px', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.55 }}>
          <div><strong style={{ color: 'var(--text)' }}>Adzuna</strong> — direct European job listings. Requires an App ID and App Key.</div>
          <div><strong style={{ color: 'var(--text)' }}>RapidAPI</strong> — provider marketplace used for JSearch and other job sources. Requires one API Key.</div>
        </div>
        <SecretField id="adzunaAppId" label="Adzuna App ID" value={adzunaAppId} onChange={setAdzunaAppId} saved={hasSavedDiscoveryKey(status, 'adzuna')} />
        <SecretField id="adzunaAppKey" label="Adzuna App Key" value={adzunaAppKey} onChange={setAdzunaAppKey} saved={hasSavedDiscoveryKey(status, 'adzuna')} />
        <SecretField id="rapidapiKey" label="RapidAPI Key" value={rapidapiKey} onChange={setRapidapiKey} saved={hasSavedDiscoveryKey(status, 'rapidapi')} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', paddingTop: 12 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['adzuna', 'rapidapi'] as const).map(provider => {
              const configured = provider === 'adzuna' ? status.hasAdzuna : status.hasRapidapi
              const userConfigured = hasSavedDiscoveryKey(status, provider)
              const test = tests[provider]
              const label = provider === 'adzuna' ? 'Test Adzuna' : 'Test RapidAPI'
              return (
                <div key={provider} style={{ display: 'flex', gap: 6 }}>
                  <button type="button" onClick={() => testConnection(provider)} disabled={!configured || test === 'testing' || keyClearing !== null} style={{ padding: '7px 10px', fontSize: 11, borderRadius: 7, border: '0.5px solid var(--border)', background: 'var(--bg-secondary)', color: test === 'ok' ? 'var(--c-success)' : 'var(--text)', cursor: configured && test !== 'testing' && keyClearing === null ? 'pointer' : 'default', opacity: configured ? 1 : 0.5 }} title={typeof test === 'object' ? test.error : undefined}>
                    {test === 'testing' ? 'Testing…' : test === 'ok' ? 'Connected ✓' : label}
                  </button>
                  {userConfigured && (
                    <button type="button" onClick={() => void clearKey(provider)} disabled={keyClearing !== null || saving} style={{ padding: '7px 8px', fontSize: 11, borderRadius: 7, border: '0.5px solid var(--border)', background: 'transparent', color: 'var(--c-danger)', cursor: keyClearing === null && !saving ? 'pointer' : 'default', opacity: keyClearing === provider ? 0.6 : 1 }}>
                      {keyClearing === provider ? 'Clearing…' : 'Clear'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          <Btn variant="primary" onClick={saveKeys} disabled={saving}>
            {saving ? 'Saving...' : 'Save discovery keys'}
          </Btn>
        </div>
        {(['adzuna', 'rapidapi'] as const).map(provider => {
          const test = tests[provider]
          return typeof test === 'object' ? (
            <div key={`${provider}-error`} style={{ marginTop: 8, fontSize: 11, color: 'var(--c-danger)' }}>
              {provider === 'adzuna' ? 'Adzuna' : 'RapidAPI'}: {test.error}
            </div>
          ) : null
        })}
      </SettingsSection>
    </div>
  )
}

// ── AI Model Settings ─────────────────────────────────────────────────────────

const TIER_COLOR = { fast: 'var(--c-warning)', standard: 'var(--primary)', premium: '#5B3DC8' }
const TIER_LABEL = { fast: '快速', standard: '标准', premium: '旗舰' }

const KEY_HINTS: Partial<Record<Provider, { href: string }>> = {
  anthropic: { href: 'https://console.anthropic.com/settings/keys' },
  openai:    { href: 'https://platform.openai.com/api-keys' },
  deepseek:  { href: 'https://platform.deepseek.com/api-keys' },
  minimax:   { href: 'https://platform.minimax.chat/user-center/basic-information/interface-key' },
  qwen:      { href: 'https://bailian.console.aliyun.com/api-key' },
  zhipu:     { href: 'https://bigmodel.cn/usercenter/apikeys' },
  kimi:      { href: 'https://platform.moonshot.ai/console/api-keys' },
}

const PROVIDERS_WITH_MODELS = Array.from(new Set(MODEL_CATALOGUE.map(m => m.provider))) as Provider[]

const FEATURE_GROUPS: Array<{ label: string; description: string; features: FeatureId[] }> = [
  {
    label: '简历与岗位分析',
    description: '简历评分、简历解析、改进建议、面试准备、职位评分与关键词提取',
    features: ['scoring', 'parsing', 'suggest', 'interviewPrep', 'jobScoring'],
  },
  {
    label: '申请材料生成',
    description: '求职信、字段建议与表单答案修改',
    features: ['coverLetter', 'fieldSuggest', 'formRevise'],
  },
  {
    label: 'Agent 自动化',
    description: 'AI Agent、表单自动填写与无人值守自动申请',
    features: ['agent', 'formFill', 'autoApply'],
  },
]

function groupConfig(settings: UserAiSettings, group: (typeof FEATURE_GROUPS)[number]): AiConfig | null | undefined {
  const configs = group.features.map(id => settings.features?.[id] ?? null)
  const signature = (cfg: AiConfig | null) => cfg ? `${cfg.provider}/${cfg.model}/${cfg.apiBase ?? ''}/${cfg.thinking ?? ''}` : 'default'
  return configs.every(cfg => signature(cfg) === signature(configs[0])) ? configs[0] : undefined
}

type TestStatus = 'idle' | 'testing' | 'ok' | { error: string }

function AiModelSettings() {
  const toast = useToast()
  const { t } = useI18n()
  const [settings,  setSettings ] = useState<UserAiSettings>({ keys: {}, features: {} })
  const [draftKeys, setDraftKeys] = useState<Partial<Record<Provider, string>>>({})
  const [saving,    setSaving   ] = useState(false)
  const [loaded,    setLoaded   ] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [keyTests,  setKeyTests ] = useState<Partial<Record<Provider, TestStatus>>>({})
  const [allTesting, setAllTesting] = useState(false)
  const [platformMinimaxReady, setPlatformMinimaxReady] = useState<boolean | null>(null)

  useEffect(() => {
    fetch('/api/me/ai-config').then(async response => {
      const data = await response.json().catch(() => null) as (UserAiSettings & { error?: string; platform?: { minimax?: boolean } }) | null
      if (!response.ok) throw new Error(data?.error ?? 'Could not load AI settings')
      setSettings({ keys: data?.keys ?? {}, features: data?.features ?? {} })
      setPlatformMinimaxReady(typeof data?.platform?.minimax === 'boolean' ? data.platform.minimax : null)
    }).catch(error => {
      setLoadError(error instanceof Error ? error.message : 'Could not load AI settings')
    }).finally(() => setLoaded(true))
  }, [])

  function setFeatureGroupCfg(group: (typeof FEATURE_GROUPS)[number], cfg: AiConfig | null) {
    setSettings(prev => ({
      ...prev,
      features: {
        ...prev.features,
        ...Object.fromEntries(group.features.map(id => [id, cfg])),
      },
    }))
  }

  async function testKey(p: Provider) {
    const key = draftKeys[p] !== undefined ? draftKeys[p] : settings.keys?.[p] || ''

    setKeyTests(prev => ({ ...prev, [p]: 'testing' }))
    const selectedFeatureEntry = Object.entries(settings.features ?? {}).find(([, config]) => config?.provider === p) ?? null
    const selectedFeature = selectedFeatureEntry?.[1] ?? null
    const catalogueOption = p === 'custom' ? null : MODEL_CATALOGUE.find(m => m.provider === p)
    const model: AiConfig | null = selectedFeature ?? (catalogueOption ? {
      provider: catalogueOption.provider,
      model: catalogueOption.model,
      ...(catalogueOption.defaultBase ? { apiBase: catalogueOption.defaultBase } : {}),
    } : null)
    if (!model) {
      setKeyTests(prev => ({ ...prev, [p]: { error: 'No model is configured for this provider' } }))
      return
    }
    const customError = p === 'custom' ? customConfigError(model) : null
    if (customError) {
      setKeyTests(prev => ({ ...prev, [p]: { error: customError } }))
      return
    }
    try {
      const res = await fetch('/api/me/ai-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: p,
          model: model.model,
          ...(selectedFeatureEntry ? { feature: selectedFeatureEntry[0] } : {}),
          ...(p === 'custom' && model.apiBase ? { apiBase: model.apiBase } : {}),
          apiKey: key && !key.startsWith('••••') ? key : undefined,
        }),
      })
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null
      setKeyTests(prev => ({ ...prev, [p]: res.ok && data?.ok ? 'ok' : { error: data?.error ?? t('settings.ai.connFail') } }))
    } catch {
      setKeyTests(prev => ({ ...prev, [p]: { error: t('settings.ai.netErr') } }))
    }
  }

  async function testAllProviders() {
    setAllTesting(true)
    const hasCustom = Object.values(settings.features ?? {}).some(config => config?.provider === 'custom')
    for (const p of PROVIDERS_WITH_MODELS.filter(p => p !== 'custom' || hasCustom)) {
      await testKey(p)
    }
    setAllTesting(false)
  }

  const customConfigInvalid = hasIncompleteCustomConfig(settings.features)

  async function save() {
    setSaving(true)
    const nextKeys: Partial<Record<Provider, string | null>> = { ...settings.keys }
    for (const provider of PROVIDERS_WITH_MODELS) {
      if (draftKeys[provider] === '') nextKeys[provider] = null
      else if (draftKeys[provider] !== undefined) nextKeys[provider] = draftKeys[provider]
    }
    const body: UserAiSettings = {
      keys:     nextKeys as Partial<Record<Provider, string>>,
      features: settings.features,
    }
    const { data, error } = await apiMutate<{ saved: boolean; settings?: UserAiSettings }>('/api/me/ai-config', 'POST', body)
    setSaving(false)
    if (error) toast.error(t('settings.ai.saveFail'), error)
    else {
      toast.success(t('settings.ai.saveOk'))
      const returnedKeys = data?.settings?.keys ?? Object.fromEntries(
        Object.entries(nextKeys).filter(([, key]) => typeof key === 'string')
      ) as Partial<Record<Provider, string>>
      setSettings(prev => ({ ...prev, ...(data?.settings ?? {}), keys: returnedKeys }))
      setDraftKeys({})
      setKeyTests({})
    }
  }

  if (!loaded) return <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>{t('settings.ai.loading')}</div>
  if (loadError) return <div style={{ padding: 14, color: 'var(--c-danger)', fontSize: 12, background: 'rgba(220,38,38,0.08)', borderRadius: 8 }}>{loadError}</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* ── ApplyMate 说明卡 ── */}
      <div style={{ padding: '14px 16px', background: 'linear-gradient(135deg,rgba(79,70,229,0.08),rgba(91,61,200,0.06))', border: '1px solid rgba(79,70,229,0.20)', borderRadius: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span style={{ fontSize: 20 }}>✦</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{APPLYMATE_LABEL}</span>
          <span style={{ fontSize: 10, background: 'rgba(79,70,229,0.08)', color: 'var(--primary)', border: '0.5px solid rgba(79,70,229,0.18)', borderRadius: 999, padding: '1px 8px', fontWeight: 600 }}>{t('settings.ai.badge')}</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          {t('settings.ai.desc')}
        </div>
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
          {t('settings.ai.underlying')}{APPLYMATE_BACKING.provider} / {APPLYMATE_BACKING.model}
        </div>
        {platformMinimaxReady === false && (
          <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 7, background: 'rgba(220,38,38,0.08)', color: 'var(--c-danger)', fontSize: 11, lineHeight: 1.5 }}>
            {t('settings.ai.platformUnavailable')}
          </div>
        )}
      </div>

      {/* ── 分功能模型控制 ── */}
      <SettingsSection title={t('settings.ai.featuresTitle')}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.6 }}>
          {t('settings.ai.featuresDesc').replace('ApplyMate AI', APPLYMATE_LABEL)} 已汇总为三类工作流；选择一个模型会同步应用到该类全部功能。
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {FEATURE_GROUPS.map(group => {
            const current = groupConfig(settings, group)
            const mixed = current === undefined
            const isDefault = current === null
            return (
              <div key={group.label} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: 8, border: '0.5px solid var(--border)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)' }}>{group.label}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                    {mixed
                      ? '当前存在不同设置；重新选择会统一覆盖本组。'
                      : isDefault
                      ? `✦ ${APPLYMATE_LABEL} ${t('settings.ai.defaultLabel')}`
                      : `${PROVIDER_LABELS[current.provider]} · ${current.model}`
                    }
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>{group.description}</div>
                </div>
                <FeatureModelPicker value={current ?? null} mixed={mixed} onChange={cfg => setFeatureGroupCfg(group, cfg)} />
                {current?.provider === 'custom' && (
                  <div style={{ flexBasis: '100%', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 8, paddingTop: 4 }}>
                    <label style={{ display: 'grid', gap: 4, fontSize: 10, color: 'var(--text-muted)' }}>
                      Custom model ID
                      <input
                        aria-label={`${group.label} custom model ID`}
                        value={current.model}
                        onChange={event => setFeatureGroupCfg(group, { ...current, model: event.target.value })}
                        placeholder="e.g. llama-3.3-70b"
                        style={{ width: '100%', boxSizing: 'border-box', padding: '7px 9px', border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg)', color: 'var(--text)', fontSize: 11 }}
                      />
                    </label>
                    <label style={{ display: 'grid', gap: 4, fontSize: 10, color: 'var(--text-muted)' }}>
                      HTTPS endpoint
                      <input
                        aria-label={`${group.label} custom HTTPS endpoint`}
                        value={current.apiBase ?? ''}
                        onChange={event => setFeatureGroupCfg(group, { ...current, apiBase: event.target.value })}
                        placeholder="https://your-endpoint.example/v1"
                        inputMode="url"
                        style={{ width: '100%', boxSizing: 'border-box', padding: '7px 9px', border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg)', color: 'var(--text)', fontSize: 11 }}
                      />
                    </label>
                    {customConfigError(current) && (
                      <div style={{ gridColumn: '1 / -1', fontSize: 10, color: 'var(--c-danger)' }}>{customConfigError(current)}</div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </SettingsSection>

      {/* ── 提供商 API Key ── */}
      <SettingsSection title={t('settings.ai.keysTitle')}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            {t('settings.ai.keysDesc')}
          </div>
          <button
            type="button"
            onClick={testAllProviders}
            disabled={allTesting}
            style={{ padding: '6px 12px', fontSize: 11, borderRadius: 7, border: '0.5px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text)', cursor: allTesting ? 'default' : 'pointer', whiteSpace: 'nowrap', opacity: allTesting ? 0.65 : 1 }}>
            {allTesting ? 'Testing...' : 'Test all'}
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {PROVIDERS_WITH_MODELS.map(p => {
            const existing = settings.keys?.[p] ?? ''
            const draft    = draftKeys[p]
            const display  = secretInputValue(existing, draft)
            const pendingClear = hasPendingSecretClear(existing, draft)
            const hint     = KEY_HINTS[p]
            const status   = keyTests[p] ?? 'idle'
            return (
              <div key={p}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', flex: 1 }}>{PROVIDER_LABELS[p]}</span>
                  {/* Status badge */}
                  {status === 'testing' && (
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t('settings.ai.testing')}</span>
                  )}
                  {status === 'ok' && (
                    <span style={{ fontSize: 10, color: 'var(--c-success)', background: 'rgba(5,150,105,0.10)', borderRadius: 999, padding: '2px 8px' }}>{t('settings.ai.connected')}</span>
                  )}
                  {typeof status === 'object' && (
                    <span style={{ fontSize: 10, color: 'var(--c-danger)', background: 'rgba(220,38,38,0.10)', borderRadius: 999, padding: '2px 8px' }} title={status.error}>✗ {status.error.slice(0, 40)}</span>
                  )}
                  {hint && (
                    <a href={hint.href} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: 'var(--primary)' }}>
                      {t('settings.ai.getKey')}
                    </a>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="password"
                    value={display}
                    onChange={e => {
                      setDraftKeys(prev => ({ ...prev, [p]: e.target.value }))
                      setKeyTests(prev => ({ ...prev, [p]: 'idle' }))
                    }}
                    placeholder={existing ? t('settings.ai.saved') : `${PROVIDER_LABELS[p]} API Key`}
                    style={{ flex: 1, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 7, fontSize: 12, color: 'var(--text)', background: 'var(--bg)', outline: 'none' }}
                  />
                  <button
                    type="button"
                    onClick={() => testKey(p)}
                    disabled={status === 'testing'}
                    style={{ padding: '0 14px', fontSize: 11, borderRadius: 7, border: '0.5px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text)', cursor: status === 'testing' ? 'default' : 'pointer', whiteSpace: 'nowrap', opacity: status === 'testing' ? 0.65 : 1 }}>
                    {t('settings.ai.testBtn')}
                  </button>
                  {existing && (
                    <button
                      type="button"
                      onClick={() => setDraftKeys(prev => pendingClear
                        ? Object.fromEntries(Object.entries(prev).filter(([provider]) => provider !== p))
                        : { ...prev, [p]: '' })}
                      style={{ padding: '0 10px', fontSize: 11, borderRadius: 7, border: '0.5px solid var(--border)', background: 'transparent', color: 'var(--c-danger)', cursor: 'pointer', whiteSpace: 'nowrap' }}
                    >
                      {pendingClear ? 'Undo' : 'Clear'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </SettingsSection>

      <Btn variant="primary" onClick={save} disabled={saving || customConfigInvalid}>
        {saving ? t('settings.ai.saving') : t('settings.ai.saveBtn')}
      </Btn>
      {customConfigInvalid && (
        <div style={{ fontSize: 11, color: 'var(--c-danger)' }}>Complete each custom model ID and HTTPS endpoint before saving.</div>
      )}
    </div>
  )
}

function FeatureModelPicker({ value, mixed, onChange }: {
  value:    AiConfig | null
  mixed?:   boolean
  onChange: (cfg: AiConfig | null) => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const isDefault = value === null && !mixed
  const isCustom = !isDefault && !mixed && value?.provider === 'custom'

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: '0.5px solid var(--border)', background: isDefault ? 'rgba(79,70,229,0.06)' : 'var(--bg)', color: isDefault ? 'var(--primary)' : 'var(--text)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
         {mixed ? 'Mixed ▾' : isDefault ? `✦ ${APPLYMATE_LABEL} ▾` : isCustom ? 'Custom ▾' : `${value!.model.split('-').slice(-1)[0]} ▾`}
      </button>

      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 49 }} onClick={() => setOpen(false)} />
          <div style={{ position: 'absolute', right: 0, top: '110%', zIndex: 50, background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.14)', minWidth: 280, maxHeight: 400, overflowY: 'auto' }}>
            <div style={{ padding: '6px 10px', fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', borderBottom: '0.5px solid var(--border)', letterSpacing: 1 }}>{t('settings.ai.pickModel').toUpperCase()}</div>

            {/* ── ApplyMate default ── */}
            <button type="button" onClick={() => { onChange(null); setOpen(false) }} style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 12px',
              background: isDefault ? 'rgba(79,70,229,0.06)' : 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
            }}>
              <span style={{ fontSize: 14 }}>✦</span>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{APPLYMATE_LABEL}</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t('settings.ai.platformDefault')}</div>
              </div>
              {isDefault && <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--primary)' }}>✓</span>}
            </button>

            <div style={{ height: 1, background: 'var(--border)', margin: '2px 0' }} />

            {PROVIDERS_WITH_MODELS.filter(p => p !== 'custom').map(provider => (
              <div key={provider}>
                <div style={{ padding: '5px 12px 3px', fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1 }}>{PROVIDER_LABELS[provider].toUpperCase()}</div>
                {MODEL_CATALOGUE.filter(m => m.provider === provider).map(m => {
                  const active = !isDefault && !mixed && value?.provider === m.provider && value?.model === m.model
                  return <ModelOption key={m.model} m={m} active={active} onSelect={() => { onChange({ provider: m.provider, model: m.model }); setOpen(false) }} />
                })}
              </div>
            ))}

            <div style={{ height: 1, background: 'var(--border)', margin: '2px 0' }} />
            <button type="button" onClick={() => { onChange({ provider: 'custom', model: '', apiBase: '' }); setOpen(false) }} style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 12px',
              background: isCustom ? 'rgba(79,70,229,0.06)' : 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
            }}>
              <span style={{ fontSize: 14 }}>⚙</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>Custom provider</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Any OpenAI-compatible HTTPS endpoint</div>
              </div>
              {isCustom && <span style={{ fontSize: 10, color: 'var(--primary)' }}>✓</span>}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function ModelOption({ m, active, onSelect }: {
  m:        (typeof MODEL_CATALOGUE)[number]
  active:   boolean
  onSelect: () => void
}) {
  return (
    <button type="button" onClick={onSelect} style={{
      display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 12px',
      background: active ? 'rgba(79,70,229,0.06)' : 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, color: 'var(--text)' }}>{m.label}</div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{m.description}</div>
      </div>
      <span style={{ fontSize: 10, color: TIER_COLOR[m.tier], background: `${TIER_COLOR[m.tier]}14`, borderRadius: 999, padding: '1px 6px', flexShrink: 0 }}>{TIER_LABEL[m.tier]}</span>
      {active && <span style={{ fontSize: 10, color: 'var(--primary)', marginLeft: 4 }}>✓</span>}
    </button>
  )
}
