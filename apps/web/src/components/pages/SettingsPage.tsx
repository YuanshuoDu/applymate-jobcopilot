'use client'

import React, { useState, useEffect, useMemo } from 'react'
import { signIn } from 'next-auth/react'
import { TopBar } from '@/components/layout/TopBar'
import { Btn, Card, useToast, useConfirm, UserAvatar } from '@/components/ui'
import type { UserProfile, UserPreferences } from '@/lib/types'
import { useApi, apiMutate } from '@/lib/hooks'
import {
  MODEL_CATALOGUE, PROVIDER_LABELS, DEFAULT_AI_CONFIG,
  type Provider, type AiConfig,
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
  { id: 'gmail',    name: 'Gmail',    icon: '✉',  color: '#A32D2D', connected: false, account: null as string | null, desc: 'Recruitment inbox monitoring' },
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

  // Fetch real OAuth connections
  useEffect(() => {
    fetch('/api/me/accounts')
      .then(r => r.json())
      .then(d => setConnectedProviders(d.accounts ?? []))
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
                {accounts.map(acc => (
                  <div key={acc.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: 14, background: 'var(--bg-secondary)', borderRadius: 10, border: '0.5px solid var(--border)' }}>
                    <div style={{ width: 36, height: 36, borderRadius: 8, background: `${acc.color}18`, color: acc.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, flexShrink: 0 }}>
                      {acc.icon}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 500 }}>{acc.name}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                        {acc.connected ? acc.account : acc.desc}
                      </div>
                    </div>
                    {acc.connected ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 10, color: '#3B6D11', background: 'rgba(59,109,17,0.12)', borderRadius: 999, padding: '2px 8px' }}>● Connected</span>
                        <Btn small variant="danger" onClick={async () => {
                          if (acc.id === 'gmail') {
                            // Google disconnection: clear apps permission link
                            window.open('https://myaccount.google.com/permissions', '_blank')
                            toast.info('Google revoke', 'Visit Google Account permissions to revoke access')
                          } else {
                            toast.warning(`${acc.name} disconnected`)
                          }
                        }}>Disconnect</Btn>
                      </div>
                    ) : (
                      <Btn small variant="primary" onClick={() => {
                        if (acc.id === 'gmail') {
                          signIn('google', { callbackUrl: window.location.href })
                        } else if (acc.id === 'github') {
                          signIn('github', { callbackUrl: window.location.href })
                        } else {
                          toast.info(`${acc.name} integration`, 'Coming soon')
                        }
                      }}>Connect</Btn>
                    )}
                  </div>
                ))}
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

function AiModelSettings() {
  const toast = useToast()
  const [cfg,     setCfg]     = useState<AiConfig>(DEFAULT_AI_CONFIG)
  const [apiKey,  setApiKey]  = useState('')
  const [apiBase, setApiBase] = useState('')
  const [saving,  setSaving]  = useState(false)
  const [loaded,  setLoaded]  = useState(false)

  useEffect(() => {
    fetch('/api/me/ai-config').then(r => r.json()).then((data: AiConfig) => {
      setCfg({ provider: data.provider ?? 'anthropic', model: data.model ?? 'claude-sonnet-4-6' })
      setApiBase(data.apiBase ?? '')
      setLoaded(true)
    }).catch(() => setLoaded(true))
  }, [])

  const providers = Array.from(new Set(MODEL_CATALOGUE.map(m => m.provider))) as Provider[]
  const modelsForProvider = MODEL_CATALOGUE.filter(m => m.provider === cfg.provider)
  const selectedModel = MODEL_CATALOGUE.find(m => m.provider === cfg.provider && m.model === cfg.model)
    ?? modelsForProvider[0]

  function selectProvider(p: Provider) {
    const firstModel = MODEL_CATALOGUE.find(m => m.provider === p)
    setCfg({ provider: p, model: firstModel?.model ?? '' })
    setApiBase(firstModel?.defaultBase ?? '')
  }

  async function save() {
    setSaving(true)
    const body: AiConfig = {
      provider: cfg.provider,
      model:    cfg.model,
      ...(apiKey.trim()  ? { apiKey:  apiKey.trim()  } : {}),
      ...(apiBase.trim() ? { apiBase: apiBase.trim() } : {}),
    }
    const { error } = await apiMutate('/api/me/ai-config', 'POST', body)
    setSaving(false)
    if (error) toast.error('保存失败', error)
    else       toast.success('AI 模型已更新')
  }

  if (!loaded) return <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>加载中…</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Provider selector */}
      <SettingsSection title="AI 提供商">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {providers.map(p => (
            <button key={p} onClick={() => selectProvider(p)} style={{
              padding: '7px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 500,
              border: `1.5px solid ${cfg.provider === p ? 'var(--primary)' : 'var(--border)'}`,
              background: cfg.provider === p ? 'rgba(24,95,165,0.08)' : 'transparent',
              color: cfg.provider === p ? 'var(--primary)' : 'var(--text-muted)',
            }}>
              {PROVIDER_LABELS[p]}
            </button>
          ))}
        </div>
      </SettingsSection>

      {/* Model selector */}
      <SettingsSection title="选择模型">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {modelsForProvider.map(m => (
            <button key={m.model} onClick={() => setCfg(prev => ({ ...prev, model: m.model }))} style={{
              display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 14px',
              borderRadius: 10, cursor: 'pointer', textAlign: 'left', width: '100%',
              border: `1.5px solid ${cfg.model === m.model ? 'var(--primary)' : 'var(--border)'}`,
              background: cfg.model === m.model ? 'rgba(24,95,165,0.06)' : 'var(--bg)',
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{m.label}</span>
                  <span style={{ fontSize: 10, fontWeight: 500, color: TIER_COLOR[m.tier], background: `${TIER_COLOR[m.tier]}14`, borderRadius: 999, padding: '1px 7px' }}>
                    {TIER_LABEL[m.tier]}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{m.description}</div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {m.priceIn === 0 && m.priceOut === 0 ? '免费' : `$${m.priceIn}/$${m.priceOut}`}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>/M tokens</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{m.contextK}K ctx</div>
              </div>
            </button>
          ))}
        </div>
      </SettingsSection>

      {/* API Key */}
      <SettingsSection title="API Key（可选）">
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.6 }}>
          留空则使用服务器默认 Key。填入自己的 Key 可独立控制用量和账单。
        </div>
        <input
          type="password"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          placeholder={`${PROVIDER_LABELS[cfg.provider]} API Key`}
          style={{ width: '100%', padding: '9px 12px', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, color: 'var(--text)', background: 'var(--bg)', outline: 'none' }}
        />
        {cfg.provider === 'anthropic'  && <KeyHint href="https://console.anthropic.com/settings/keys" />}
        {cfg.provider === 'openai'     && <KeyHint href="https://platform.openai.com/api-keys" />}
        {cfg.provider === 'deepseek'   && <KeyHint href="https://platform.deepseek.com/api-keys" />}
        {cfg.provider === 'minimax'    && <KeyHint href="https://platform.minimax.chat/user-center/basic-information/interface-key" />}
        {cfg.provider === 'qwen'       && <KeyHint href="https://dashscope.console.aliyun.com/apiKey" label="阿里云 DashScope" />}
        {cfg.provider === 'zhipu'      && <KeyHint href="https://open.bigmodel.cn/usercenter/apikeys" label="智谱开放平台" />}
      </SettingsSection>

      {/* Custom base URL */}
      {(cfg.provider === 'custom' || apiBase) && (
        <SettingsSection title="API Base URL">
          <input
            type="url"
            value={apiBase}
            onChange={e => setApiBase(e.target.value)}
            placeholder="https://your-endpoint/v1"
            style={{ width: '100%', padding: '9px 12px', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, color: 'var(--text)', background: 'var(--bg)', outline: 'none' }}
          />
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
            任何 OpenAI-compatible 端点均可使用，例如本地 Ollama: <code style={{ fontFamily: 'monospace' }}>http://localhost:11434/v1</code>
          </div>
        </SettingsSection>
      )}

      {/* Current selection summary */}
      {selectedModel && (
        <div style={{ padding: '12px 14px', background: 'rgba(24,95,165,0.05)', borderRadius: 10, border: '1px solid rgba(24,95,165,0.15)', fontSize: 12, color: 'var(--text-muted)' }}>
          当前选择：<strong style={{ color: 'var(--text)' }}>{selectedModel.label}</strong>
          {' · '}输入 ${selectedModel.priceIn}/M · 输出 ${selectedModel.priceOut}/M · {selectedModel.contextK}K 上下文
        </div>
      )}

      <Btn variant="primary" onClick={save} disabled={saving}>
        {saving ? '保存中…' : '保存模型设置'}
      </Btn>
    </div>
  )
}

function KeyHint({ href, label }: { href: string; label?: string }) {
  return (
    <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
      获取 API Key：
      <a href={href} target="_blank" rel="noreferrer" style={{ color: 'var(--primary)', marginLeft: 4 }}>
        {label ?? '控制台 ↗'}
      </a>
    </div>
  )
}
