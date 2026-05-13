'use client'

import React, { useState, useEffect, useMemo } from 'react'
import { signIn } from 'next-auth/react'
import { TopBar } from '@/components/layout/TopBar'
import { Btn, Card, useToast, useConfirm, UserAvatar } from '@/components/ui'
import type { UserProfile, UserPreferences } from '@/lib/types'
import { useApi, apiMutate } from '@/lib/hooks'
import {
  MODEL_CATALOGUE, PROVIDER_LABELS, FEATURE_LABELS, APPLYMATE_BACKING, APPLYMATE_LABEL,
  type Provider, type AiConfig, type FeatureId, type UserAiSettings,
} from '@/lib/model-router'

// ── Static data ───────────────────────────────────────────────────────────────

const PLANS = [
  {
    id: 'free', name: 'Free', price: '€0', period: 'forever',
    features: ['5 applications/month', 'Basic CV tailoring', 'Job tracker (20 jobs)', 'Extension popup'],
  },
  {
    id: 'pro', name: 'Pro', price: '€12', period: 'month',
    features: ['Unlimited applications', 'AI CV tailoring per role', 'Unlimited tracker', 'Full sidebar', 'AI cover letters', 'Gmail integration', 'Priority support'],
  },
  {
    id: 'team', name: 'Team', price: '€29', period: 'month',
    features: ['Everything in Pro', '5 team seats', 'Shared job pool', 'Analytics dashboard', 'Custom AI model', 'Dedicated support'],
  },
]

const CONNECTED_ACCOUNTS = [
  { id: 'gmail',    name: 'Gmail',    icon: '✉',  color: '#A32D2D', connected: false, account: null as string | null, desc: 'AI email detection, auto-labeling & follow-up' },
  { id: 'linkedin', name: 'LinkedIn', icon: 'in', color: '#185FA5', connected: false, account: null as string | null, desc: 'Job search + auto-apply'      },
  { id: 'indeed',   name: 'Indeed',   icon: 'I',  color: '#003A9B', connected: false, account: null as string | null, desc: 'Job aggregation'               },
  { id: 'github',   name: 'GitHub',   icon: '⌥',  color: '#24292f', connected: false, account: null as string | null, desc: 'Pull CV data from repos'       },
]

// ── UI helpers ────────────────────────────────────────────────────────────────

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card style={{ overflow: 'hidden' }}>
      <div style={{ padding: '12px 16px', borderBottom: '0.5px solid var(--border)', background: 'var(--bg-secondary)' }}>
        <span style={{ fontSize: 12, fontWeight: 500 }}>{title}</span>
      </div>
      <div style={{ padding: 16 }}>{children}</div>
    </Card>
  )
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '0.5px solid var(--border)' }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 140 }}>{label}</span>
      <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>{children}</div>
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
      style={{ padding: '6px 10px', fontSize: 12, border: '0.5px solid var(--border)', borderRadius: 6, background: readOnly ? 'var(--bg-secondary)' : 'var(--bg)', color: 'var(--text)', outline: 'none', width: 220, opacity: readOnly ? 0.7 : 1, ...style }}
    />
  )
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div onClick={() => onChange(!value)} style={{ width: 32, height: 18, borderRadius: 9, background: value ? '#185FA5' : 'var(--border)', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
      <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#fff', position: 'absolute', top: 2, left: value ? 16 : 2, transition: 'left 0.2s' }} />
    </div>
  )
}

// ── SettingsPage ──────────────────────────────────────────────────────────────

type Tab = 'profile' | 'accounts' | 'ai' | 'billing' | 'notifs' | 'privacy'

export function SettingsPage() {
  const toast = useToast()
  const [confirm, ConfirmDialog] = useConfirm()

  // Load user profile
  const { data: user, loading: userLoading } = useApi<UserProfile>('/api/me')

  // Profile form state (editable fields)
  const [name,     setName    ] = useState('')
  const [phone,    setPhone   ] = useState('')
  const [location, setLocation] = useState('')
  const [linkedin, setLinkedin] = useState('')
  const [github,   setGithub  ] = useState('')
  const [saving,   setSaving  ] = useState(false)

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
    if (user.preferences) {
      setPrefRoles(user.preferences.targetRoles ?? '')
      setPrefLocations(user.preferences.targetLocations ?? '')
      setPrefSalary(user.preferences.salaryExpectation ?? '')
      setPrefVisa(user.preferences.workAuthorization ?? 'EU citizen / no visa required')
      setPrefRelocate(user.preferences.openToRelocation ?? true)
    }
  }, [user])

  const [activeTab,      setActiveTab     ] = useState<Tab>('profile')
  const [notifs,         setNotifs        ] = useState({ apply: true, reject: true, interview: true, offer: true, weekly: false, followUp: true })
  const [showCancelModal,   setShowCancelModal]   = useState(false)
  const [connectedProviders, setConnectedProviders] = useState<{ provider: string; account: string }[]>([])
  const [gmailHealth, setGmailHealth] = useState<{ hasGmail: boolean; reason: string | null; scopes?: string; gmailError?: string }>({ hasGmail: true, reason: null })

  // Fetch real OAuth connections + gmail health
  useEffect(() => {
    fetch('/api/me/accounts')
      .then(r => r.json())
      .then(d => setConnectedProviders(d.accounts ?? []))
      .catch(() => {})
    fetch('/api/gmail/check')
      .then(r => r.json())
      .then(d => setGmailHealth({ hasGmail: d.hasGmail, reason: d.reason, scopes: d.scopes, gmailError: d.gmailError }))
      .catch(() => {})
  }, [])

  // Merge real connections with static config
  const accounts = useMemo(() => {
    return CONNECTED_ACCOUNTS.map(acc => {
      const conn = connectedProviders.find(c => c.provider === acc.id || (acc.id === 'gmail' && c.provider === 'google'))
      return conn ? { ...acc, connected: true, account: conn.account } : acc
    })
  }, [connectedProviders])

  // Password change state
  const [passwordCur,  setPasswordCur]  = useState('')
  const [passwordNew,  setPasswordNew]  = useState('')
  const [passwordConf, setPasswordConf] = useState('')
  const [pwSaving,     setPwSaving]     = useState(false)

  const TABS: { id: Tab; label: string }[] = [
    { id: 'profile',  label: 'Profile'        },
    { id: 'accounts', label: 'Accounts'       },
    { id: 'ai',       label: 'AI 模型'        },
    { id: 'billing',  label: 'Plan & Billing' },
    { id: 'notifs',   label: 'Notifications'  },
    { id: 'privacy',  label: 'Privacy'        },
  ]

  const planLabel = user?.plan === 'pro' ? 'Pro' : user?.plan === 'enterprise' ? 'Team' : 'Free'

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

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg-tertiary)', display: 'flex', flexDirection: 'column' }}>
      <ConfirmDialog />
      <TopBar title="Settings">
        <Btn variant="primary" onClick={saveProfile} disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </Btn>
      </TopBar>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Settings sidebar tabs */}
        <div style={{ width: 180, flexShrink: 0, background: 'var(--bg-secondary)', borderRight: '0.5px solid var(--border)', padding: '12px 8px' }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
              display: 'block', width: '100%', padding: '8px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', textAlign: 'left',
              background: activeTab === t.id ? 'var(--bg)'      : 'transparent',
              color:      activeTab === t.id ? 'var(--text)'     : 'var(--text-muted)',
              fontWeight: activeTab === t.id ? 500               : 400,
              fontSize: 12, marginBottom: 1,
            }}>{t.label}</button>
          ))}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* ── Profile ── */}
          {activeTab === 'profile' && (
            <>
              <SettingsSection title="Personal Information">
                {userLoading ? (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '12px 0' }}>Loading…</div>
                ) : (
                  <>
                    {/* Avatar */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16, paddingBottom: 16, borderBottom: '0.5px solid var(--border)' }}>
                      <UserAvatar src={user?.image} name={user?.name} email={user?.email} size={60} />
                      <div>
                        <Btn small variant="ghost" onClick={() => toast.info('Upload photo')}>Upload photo</Btn>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>JPG, PNG up to 2MB</div>
                      </div>
                    </div>

                    {/* Editable fields */}
                    <FieldRow label="Full name">
                      <Input value={name} onChange={e => setName(e.target.value)} placeholder="Your name" />
                    </FieldRow>
                    <FieldRow label="Email">
                      <Input value={user?.email ?? ''} readOnly placeholder="email@example.com" />
                    </FieldRow>
                    <FieldRow label="Phone">
                      <Input type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+1 555 000 0000" />
                    </FieldRow>
                    <FieldRow label="Location">
                      <Input value={location} onChange={e => setLocation(e.target.value)} placeholder="City, Country" />
                    </FieldRow>
                    <FieldRow label="LinkedIn">
                      <Input value={linkedin} onChange={e => setLinkedin(e.target.value)} placeholder="linkedin.com/in/you" />
                    </FieldRow>
                    <FieldRow label="GitHub">
                      <Input value={github} onChange={e => setGithub(e.target.value)} placeholder="github.com/you" />
                    </FieldRow>
                  </>
                )}
              </SettingsSection>

              <SettingsSection title="Job Preferences">
                <FieldRow label="Target roles">    <Input value={prefRoles}     onChange={e => setPrefRoles(e.target.value)}     placeholder="Backend Engineer, SWE" /></FieldRow>
                <FieldRow label="Target locations"><Input value={prefLocations} onChange={e => setPrefLocations(e.target.value)} placeholder="Amsterdam, Berlin, Remote" /></FieldRow>
                <FieldRow label="Salary expectation"><Input value={prefSalary}   onChange={e => setPrefSalary(e.target.value)}    placeholder="€65,000 – €90,000" /></FieldRow>
                <FieldRow label="Work authorisation">
                  <select value={prefVisa} onChange={e => setPrefVisa(e.target.value)} style={{ padding: '6px 10px', fontSize: 12, border: '0.5px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)', outline: 'none' }}>
                    <option>EU citizen / no visa required</option>
                    <option>Requires sponsorship</option>
                    <option>Open work permit</option>
                  </select>
                </FieldRow>
                <FieldRow label="Open to relocation"><Toggle value={prefRelocate} onChange={setPrefRelocate} /></FieldRow>
              </SettingsSection>

              <SettingsSection title="Password">
                <FieldRow label="Current password">
                  <Input type="password" value={passwordCur}  onChange={e => setPasswordCur(e.target.value)}  placeholder="••••••••" />
                </FieldRow>
                <FieldRow label="New password">
                  <Input type="password" value={passwordNew}  onChange={e => setPasswordNew(e.target.value)}  placeholder="••••••••" />
                </FieldRow>
                <FieldRow label="Confirm password">
                  <Input type="password" value={passwordConf} onChange={e => setPasswordConf(e.target.value)} placeholder="••••••••" />
                </FieldRow>
                <div style={{ marginTop: 12 }}>
                  <Btn variant="ghost" disabled={pwSaving} onClick={async () => {
                    if (!passwordCur || !passwordNew) { toast.info('Enter current and new password'); return }
                    if (passwordNew !== passwordConf) { toast.error('Mismatch', 'New password and confirmation do not match'); return }
                    if (passwordNew.length < 8) { toast.error('Too short', 'Password must be at least 8 characters'); return }
                    setPwSaving(true)
                    const { error } = await apiMutate('/api/me/password', 'PATCH', { currentPassword: passwordCur, newPassword: passwordNew })
                    setPwSaving(false)
                    if (error) { toast.error('Password change failed', error) }
                    else {
                      toast.success('Password updated')
                      setPasswordCur(''); setPasswordNew(''); setPasswordConf('')
                    }
                  }}>{pwSaving ? 'Updating…' : 'Update password'}</Btn>
                </div>
              </SettingsSection>
            </>
          )}

          {/* ── AI 模型 ── */}
          {activeTab === 'ai' && <AiModelSettings />}

          {/* ── Accounts ── */}
          {activeTab === 'accounts' && (
            <SettingsSection title="Connected Accounts">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {accounts.map(acc => {
                  const isGmail = acc.id === 'gmail'
                  const gmailNeedsFix = isGmail && acc.connected && !gmailHealth.hasGmail
                  return (
                    <div key={acc.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: 14, background: 'var(--bg-secondary)', borderRadius: 10, border: gmailNeedsFix ? '1px solid rgba(163,45,45,0.25)' : '0.5px solid var(--border)' }}>
                      <div style={{ width: 36, height: 36, borderRadius: 8, background: `${acc.color}18`, color: acc.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, flexShrink: 0 }}>
                        {acc.icon}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                          {acc.name}
                          {gmailNeedsFix && (
                            <span style={{ fontSize: 9, background: 'rgba(163,45,45,0.12)', color: '#A32D2D', borderRadius: 999, padding: '1px 6px' }}>Needs fix</span>
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
                          <div style={{ fontSize: 9, color: '#A32D2D', marginTop: 4, wordBreak: 'break-all', opacity: 0.7 }}>
                            {gmailHealth.gmailError}
                          </div>
                        )}
                      </div>
                      {acc.connected ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {gmailNeedsFix ? (
                            <Btn small variant="primary" onClick={() => {
                              fetch('/api/me/accounts', {
                                method: 'DELETE',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ provider: 'google' }),
                              }).then(() => signIn('google', { callbackUrl: window.location.origin + '/?page=settings' }))
                            }}>Fix Gmail Access</Btn>
                          ) : (
                            <span style={{ fontSize: 10, color: '#3B6D11', background: 'rgba(59,109,17,0.12)', borderRadius: 999, padding: '2px 8px' }}>● Connected</span>
                          )}
                          <Btn small variant="danger" onClick={async () => {
                            if (isGmail) {
                              await fetch('/api/me/accounts', {
                                method: 'DELETE',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ provider: 'google' }),
                              })
                              fetch('/api/me/accounts')
                                .then(r => r.json())
                                .then(d => setConnectedProviders(d.accounts ?? []))
                                .catch(() => {})
                              setGmailHealth({ hasGmail: true, reason: null })
                              window.open('https://myaccount.google.com/permissions', '_blank')
                              toast.info('Gmail disconnected', 'Visit Google permissions to fully revoke access')
                            } else {
                              toast.warning(`${acc.name} disconnected`)
                            }
                          }}>Disconnect</Btn>
                        </div>
                      ) : (
                        <Btn small variant="primary" onClick={() => {
                          if (isGmail) {
                            signIn('google', { callbackUrl: window.location.origin + '/?page=settings' })
                          } else if (acc.id === 'github') {
                            signIn('github', { callbackUrl: window.location.origin + '/?page=settings' })
                          } else {
                            toast.info(`${acc.name} integration`, 'Coming soon')
                          }
                        }}>Connect</Btn>
                      )}
                    </div>
                  )
                })}
              </div>
            </SettingsSection>
          )}

          {/* ── Billing ── */}
          {activeTab === 'billing' && (
            <>
              <SettingsSection title="Current Plan">
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{planLabel} Plan</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      {user?.plan === 'free' ? 'Free forever' : 'Renews monthly'}
                    </div>
                  </div>
                  <span style={{ marginLeft: 'auto', fontSize: 10, background: 'rgba(24,95,165,0.12)', color: '#185FA5', borderRadius: 999, padding: '3px 10px', fontWeight: 500 }}>Active</span>
                </div>
                <Btn variant="ghost" onClick={() => toast.info('Opening billing portal')}>Manage billing →</Btn>
              </SettingsSection>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
                {PLANS.map(plan => {
                  const isCurrent = (user?.plan ?? 'free') === plan.id
                  return (
                    <Card key={plan.id} style={{ padding: 16, border: isCurrent ? '1.5px solid #185FA5' : '0.5px solid var(--border)', background: isCurrent ? 'rgba(24,95,165,0.03)' : 'var(--bg)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                        <span style={{ fontSize: 13, fontWeight: 500 }}>{plan.name}</span>
                        {isCurrent && <span style={{ fontSize: 10, background: 'rgba(24,95,165,0.12)', color: '#185FA5', borderRadius: 999, padding: '2px 7px' }}>Current</span>}
                      </div>
                      <div style={{ marginBottom: 12 }}>
                        <span style={{ fontSize: 22, fontWeight: 500 }}>{plan.price}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}> / {plan.period}</span>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 14 }}>
                        {plan.features.map(f => (
                          <div key={f} style={{ display: 'flex', gap: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                            <span style={{ color: '#3B6D11', flexShrink: 0 }}>✓</span>{f}
                          </div>
                        ))}
                      </div>
                      <Btn variant={isCurrent ? 'ghost' : 'primary'} style={{ width: '100%', justifyContent: 'center' }}
                        onClick={() => isCurrent ? setShowCancelModal(true) : toast.success(`Upgraded to ${plan.name}`)}>
                        {isCurrent ? 'Cancel plan' : plan.id === 'free' ? 'Downgrade' : 'Upgrade'}
                      </Btn>
                    </Card>
                  )
                })}
              </div>
            </>
          )}

          {/* ── Notifications ── */}
          {activeTab === 'notifs' && (
            <SettingsSection title="Notification Preferences">
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
                  <Toggle value={notifs[n.key]} onChange={v => setNotifs(s => ({ ...s, [n.key]: v }))} />
                </div>
              ))}
            </SettingsSection>
          )}

          {/* ── Privacy ── */}
          {activeTab === 'privacy' && (
            <>
              <SettingsSection title="Data & Privacy">
                {[
                  { label: 'Share anonymous usage data',          sub: 'Helps us improve ApplyMate',         value: true  },
                  { label: 'Allow AI training on your CVs',       sub: 'Your data is always anonymised',     value: false },
                  { label: 'Store cover letters for improvement', sub: 'Used to improve generation quality', value: true  },
                ].map((item, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '12px 0', borderBottom: '0.5px solid var(--border)' }}>
                    <div>
                      <div style={{ fontSize: 12 }}>{item.label}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{item.sub}</div>
                    </div>
                    <Toggle value={item.value} onChange={() => {}} />
                  </div>
                ))}
                <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                  <Btn variant="ghost" onClick={() => toast.info('Downloading data…')}>Download my data</Btn>
                  <Btn variant="ghost" onClick={() => toast.info('Request sent', 'We will delete your data within 30 days')}>Request data deletion</Btn>
                </div>
              </SettingsSection>

              <Card style={{ padding: 16, border: '0.5px solid rgba(163,45,45,0.3)', background: 'rgba(163,45,45,0.03)' }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: '#A32D2D', marginBottom: 8 }}>Danger Zone</div>
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
                  if (typed !== user?.email) {
                    toast.warning('Cancelled', 'Email did not match — account preserved')
                    return
                  }
                  const { error } = await apiMutate('/api/me', 'DELETE', { confirmation: user?.email })
                  if (error) {
                    toast.error('Deletion failed', error)
                  } else {
                    toast.success('Account deleted', 'Redirecting…')
                    setTimeout(() => window.location.href = '/login', 1500)
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
              <Btn variant="danger" style={{ flex: 1, justifyContent: 'center' }} onClick={() => { setShowCancelModal(false); toast.warning('Plan cancelled', 'Access continues until period end') }}>Cancel plan</Btn>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}

// ── AI Model Settings ─────────────────────────────────────────────────────────

const TIER_COLOR = { fast: '#854F0B', standard: '#185FA5', premium: '#5B3DC8' }
const TIER_LABEL = { fast: '快速', standard: '标准', premium: '旗舰' }

const KEY_HINTS: Partial<Record<Provider, { href: string }>> = {
  anthropic: { href: 'https://console.anthropic.com/settings/keys' },
  openai:    { href: 'https://platform.openai.com/api-keys' },
  deepseek:  { href: 'https://platform.deepseek.com/api-keys' },
  minimax:   { href: 'https://platform.minimax.chat/user-center/basic-information/interface-key' },
  qwen:      { href: 'https://bailian.console.aliyun.com/api-key' },
  zhipu:     { href: 'https://bigmodel.cn/usercenter/apikeys' },
}

const PROVIDERS_WITH_MODELS = Array.from(new Set(MODEL_CATALOGUE.map(m => m.provider))) as Provider[]
const FEATURE_IDS = Object.keys(FEATURE_LABELS) as FeatureId[]
const RECOMMENDED_MODELS = MODEL_CATALOGUE.filter(m => m.label.includes('★'))

type TestStatus = 'idle' | 'testing' | 'ok' | { error: string }

function AiModelSettings() {
  const toast = useToast()
  const [settings,  setSettings ] = useState<UserAiSettings>({ keys: {}, features: {} })
  const [draftKeys, setDraftKeys] = useState<Partial<Record<Provider, string>>>({})
  const [saving,    setSaving   ] = useState(false)
  const [loaded,    setLoaded   ] = useState(false)
  const [keyTests,  setKeyTests ] = useState<Partial<Record<Provider, TestStatus>>>({})

  useEffect(() => {
    fetch('/api/me/ai-config').then(r => r.json()).then((data: UserAiSettings) => {
      setSettings(data)
      setLoaded(true)
    }).catch(() => setLoaded(true))
  }, [])

  function setFeatureCfg(id: FeatureId, cfg: AiConfig | null) {
    setSettings(prev => ({ ...prev, features: { ...prev.features, [id]: cfg } }))
  }

  async function testKey(p: Provider) {
    const key = draftKeys[p] || settings.keys?.[p] || ''
    if (!key || key.startsWith('••••')) { toast.info('请先填写 API Key'); return }

    setKeyTests(prev => ({ ...prev, [p]: 'testing' }))
    const model = MODEL_CATALOGUE.find(m => m.provider === p)
    try {
      const res = await fetch('/api/me/ai-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: p, model: model?.model, apiKey: key }),
      })
      const data = await res.json()
      setKeyTests(prev => ({ ...prev, [p]: data.ok ? 'ok' : { error: data.error ?? '连接失败' } }))
    } catch {
      setKeyTests(prev => ({ ...prev, [p]: { error: '网络错误' } }))
    }
  }

  async function save() {
    setSaving(true)
    const body: UserAiSettings = {
      keys:     { ...settings.keys, ...draftKeys },
      features: settings.features,
    }
    const { error } = await apiMutate('/api/me/ai-config', 'POST', body)
    setSaving(false)
    if (error) toast.error('保存失败', error)
    else { toast.success('AI 设置已更新'); setDraftKeys({}); setKeyTests({}) }
  }

  if (!loaded) return <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>加载中…</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* ── ApplyMate 说明卡 ── */}
      <div style={{ padding: '14px 16px', background: 'linear-gradient(135deg,rgba(24,95,165,0.08),rgba(91,61,200,0.06))', border: '1px solid rgba(24,95,165,0.2)', borderRadius: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span style={{ fontSize: 20 }}>✦</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{APPLYMATE_LABEL}</span>
          <span style={{ fontSize: 10, background: '#185FA514', color: '#185FA5', border: '0.5px solid #185FA530', borderRadius: 999, padding: '1px 8px', fontWeight: 600 }}>默认</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          平台内置模型，无需填写 API Key，开箱即用。当前由 <strong style={{ color: 'var(--text)' }}>MiniMax M2.7</strong> 提供支持，适合所有功能的日常使用。
        </div>
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
          底层模型：{APPLYMATE_BACKING.provider} / {APPLYMATE_BACKING.model}
        </div>
      </div>

      {/* ── 分功能模型控制 ── */}
      <SettingsSection title="各功能模型设置">
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.6 }}>
          默认所有功能使用 {APPLYMATE_LABEL}。可为每个功能单独指定模型（需先在下方添加对应 API Key）。
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {FEATURE_IDS.map(id => {
            const current   = settings.features?.[id] ?? null
            const isDefault = current === null
            return (
              <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: 8, border: '0.5px solid var(--border)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)' }}>{FEATURE_LABELS[id]}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                    {isDefault
                      ? `✦ ${APPLYMATE_LABEL}（默认）`
                      : `${PROVIDER_LABELS[current!.provider]} · ${current!.model}`
                    }
                  </div>
                </div>
                <FeatureModelPicker value={current} onChange={cfg => setFeatureCfg(id, cfg)} />
              </div>
            )
          })}
        </div>
      </SettingsSection>

      {/* ── 提供商 API Key ── */}
      <SettingsSection title="自定义 API Key（可选）">
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.6 }}>
          填入各提供商的 API Key 后，选择该提供商模型时将优先使用你的 Key，账单记在你的账户。留空则使用平台共享额度。
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {PROVIDERS_WITH_MODELS.filter(p => p !== 'custom').map(p => {
            const existing = settings.keys?.[p] ?? ''
            const draft    = draftKeys[p] ?? ''
            const display  = draft || existing
            const hint     = KEY_HINTS[p]
            const status   = keyTests[p] ?? 'idle'
            return (
              <div key={p}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', flex: 1 }}>{PROVIDER_LABELS[p]}</span>
                  {/* Status badge */}
                  {status === 'testing' && (
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>测试中…</span>
                  )}
                  {status === 'ok' && (
                    <span style={{ fontSize: 10, color: '#3B6D11', background: 'rgba(59,109,17,0.1)', borderRadius: 999, padding: '2px 8px' }}>✓ 连接正常</span>
                  )}
                  {typeof status === 'object' && (
                    <span style={{ fontSize: 10, color: '#A32D2D', background: 'rgba(163,45,45,0.1)', borderRadius: 999, padding: '2px 8px' }} title={status.error}>✗ {status.error.slice(0, 40)}</span>
                  )}
                  {hint && (
                    <a href={hint.href} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: 'var(--primary)' }}>
                      获取 Key ↗
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
                    placeholder={existing ? '已保存（输入新值可覆盖）' : `${PROVIDER_LABELS[p]} API Key`}
                    style={{ flex: 1, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 7, fontSize: 12, color: 'var(--text)', background: 'var(--bg)', outline: 'none' }}
                  />
                  <button
                    onClick={() => testKey(p)}
                    disabled={status === 'testing' || (!display || display.startsWith('••••'))}
                    style={{ padding: '0 14px', fontSize: 11, borderRadius: 7, border: '0.5px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text)', cursor: 'pointer', whiteSpace: 'nowrap', opacity: (!display || display.startsWith('••••')) ? 0.4 : 1 }}>
                    测试
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </SettingsSection>

      <Btn variant="primary" onClick={save} disabled={saving}>
        {saving ? '保存中…' : '保存 AI 设置'}
      </Btn>
    </div>
  )
}

function FeatureModelPicker({ value, onChange }: {
  value:    AiConfig | null
  onChange: (cfg: AiConfig | null) => void
}) {
  const [open, setOpen] = useState(false)
  const isDefault = value === null

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: '0.5px solid var(--border)', background: isDefault ? 'rgba(24,95,165,0.06)' : 'var(--bg)', color: isDefault ? '#185FA5' : 'var(--text)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
        {isDefault ? `✦ ${APPLYMATE_LABEL} ▾` : `${value!.model.split('-').slice(-1)[0]} ▾`}
      </button>

      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 49 }} onClick={() => setOpen(false)} />
          <div style={{ position: 'absolute', right: 0, top: '110%', zIndex: 50, background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.14)', minWidth: 280, maxHeight: 400, overflowY: 'auto' }}>
            <div style={{ padding: '6px 10px', fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', borderBottom: '0.5px solid var(--border)', letterSpacing: 1 }}>选择模型</div>

            {/* ── ApplyMate default ── */}
            <button onClick={() => { onChange(null); setOpen(false) }} style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 12px',
              background: isDefault ? 'rgba(24,95,165,0.06)' : 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
            }}>
              <span style={{ fontSize: 14 }}>✦</span>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{APPLYMATE_LABEL}</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>平台默认 · 无需 Key</div>
              </div>
              {isDefault && <span style={{ marginLeft: 'auto', fontSize: 10, color: '#185FA5' }}>✓</span>}
            </button>

            <div style={{ height: 1, background: 'var(--border)', margin: '2px 0' }} />

            {/* ── 推荐模型 ── */}
            <div style={{ padding: '5px 12px 3px', fontSize: 9, fontWeight: 700, color: '#185FA5', letterSpacing: 1 }}>★ 推荐</div>
            {RECOMMENDED_MODELS.map(m => {
              const active = !isDefault && value?.provider === m.provider && value?.model === m.model
              return (
                <ModelOption key={`rec-${m.model}`} m={m} active={active} onSelect={() => { onChange({ provider: m.provider, model: m.model }); setOpen(false) }} />
              )
            })}

            <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />

            {/* ── 按提供商分组完整列表 ── */}
            {PROVIDERS_WITH_MODELS.map(p => (
              <div key={p}>
                <div style={{ padding: '5px 12px', fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1 }}>{PROVIDER_LABELS[p].toUpperCase()}</div>
                {MODEL_CATALOGUE.filter(m => m.provider === p).map(m => {
                  const active = !isDefault && value?.provider === p && value?.model === m.model
                  return (
                    <ModelOption key={m.model} m={m} active={active} onSelect={() => { onChange({ provider: p, model: m.model }); setOpen(false) }} />
                  )
                })}
              </div>
            ))}
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
    <button onClick={onSelect} style={{
      display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 12px',
      background: active ? 'rgba(24,95,165,0.06)' : 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, color: 'var(--text)' }}>{m.label}</div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{m.description}</div>
      </div>
      <span style={{ fontSize: 10, color: TIER_COLOR[m.tier], background: `${TIER_COLOR[m.tier]}14`, borderRadius: 999, padding: '1px 6px', flexShrink: 0 }}>{TIER_LABEL[m.tier]}</span>
      {active && <span style={{ fontSize: 10, color: '#185FA5', marginLeft: 4 }}>✓</span>}
    </button>
  )
}
