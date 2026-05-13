import { useState, useEffect, useCallback } from 'react'
import { getSettings, saveSettings, isLoggedIn, clearAuth } from '@/lib/storage'
import { login as apiLogin } from '@/lib/api'
import type { ExtensionSettings, ScrapedJob, SavedJob, DashboardStats } from '@/lib/types'

// ── Design tokens ─────────────────────────────────────────────
const C = {
  primary:      '#185FA5',
  primaryHover: '#1a6dbf',
  green:        '#3B6D11',
  red:          '#A32D2D',
  amber:        '#854F0B',
  teal:         '#0E7490',
  purple:       '#7C3AED',
  bg:           '#f0f4f8',
  bgCard:       '#ffffff',
  border:       '#e2e8f0',
  text:         '#0f172a',
  muted:        '#64748b',
  subtle:       '#94a3b8',
}

const SOURCE_META: Record<string, { color: string; label: string }> = {
  linkedin:  { color: '#0077B5', label: 'LinkedIn'  },
  indeed:    { color: '#003A9B', label: 'Indeed'    },
  glassdoor: { color: '#0CAA41', label: 'Glassdoor' },
  stepstone: { color: '#E8001E', label: 'Stepstone' },
  xing:      { color: '#026466', label: 'Xing'      },
  wellfound: { color: '#333333', label: 'Wellfound' },
  greenhouse:{ color: '#3BB273', label: 'Greenhouse'},
  lever:     { color: '#005AFF', label: 'Lever'     },
  workday:   { color: '#F5821F', label: 'Workday'   },
  unknown:   { color: C.primary, label: 'Job'       },
}

const STATUS_META: Record<string, { color: string; label: string }> = {
  saved:     { color: C.subtle,   label: '已存'   },
  applied:   { color: C.primary,  label: '已申请' },
  review:    { color: C.amber,    label: '审核中' },
  interview: { color: C.teal,     label: '面试'   },
  offer:     { color: C.green,    label: 'Offer'  },
  rejected:  { color: C.red,      label: '已拒绝' },
}

function formatDate(iso: string): string {
  const d    = new Date(iso)
  const now  = new Date()
  const diff = Math.floor((now.getTime() - d.getTime()) / 86400000)
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  if (diff < 7)  return `${diff}天前`
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

// ── Global styles injected once ───────────────────────────────
const GLOBAL_CSS = `
  @keyframes am-spin { to { transform: rotate(360deg) } }
  * { box-sizing: border-box; }
  body { margin: 0; width: 360px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
`

// ── Main App ─────────────────────────────────────────────────

export function App() {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null)
  const [view,     setView]     = useState<'main' | 'login' | 'settings'>('main')
  const [loading,  setLoading]  = useState(true)

  useEffect(() => {
    getSettings().then(s => {
      setSettings(s)
      setLoading(false)
      if (!isLoggedIn(s)) setView('login')
    })
  }, [])

  const refresh = useCallback(() => { getSettings().then(setSettings) }, [])

  return (
    <>
      <style>{GLOBAL_CSS}</style>
      {loading || !settings ? (
        <LoadingScreen />
      ) : view === 'login' ? (
        <LoginView settings={settings} onLogin={s => { setSettings(s); setView('main') }} />
      ) : view === 'settings' ? (
        <SettingsView settings={settings} refresh={refresh} onBack={() => setView('main')} />
      ) : (
        <MainView
          settings={settings}
          onSettings={() => setView('settings')}
          onLogout={() => { clearAuth(); setView('login') }}
        />
      )}
    </>
  )
}

// ── Loading ───────────────────────────────────────────────────

function LoadingScreen() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 240, gap: 10 }}>
      <div style={{ width: 22, height: 22, border: `2.5px solid rgba(24,95,165,0.15)`, borderTopColor: C.primary, borderRadius: '50%', animation: 'am-spin 0.7s linear infinite' }} />
      <span style={{ color: C.subtle, fontSize: 11 }}>Loading…</span>
    </div>
  )
}

// ── Login View ────────────────────────────────────────────────

function LoginView({ settings, onLogin }: { settings: ExtensionSettings; onLogin: (s: ExtensionSettings) => void }) {
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const result = await apiLogin(settings, email, password)
      const next   = { ...settings, apiToken: result.token, userEmail: result.user.email, userName: result.user.name ?? '' }
      await saveSettings(next)
      onLogin(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ background: C.bg, minHeight: 320 }}>
      <Header showSettings={false} />
      <div style={{ padding: '20px 20px 24px' }}>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <div style={{
            width: 56, height: 56, borderRadius: 16, margin: '0 auto 12px',
            background: `linear-gradient(135deg, ${C.primary} 0%, #2d88d4 100%)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 26, boxShadow: `0 6px 20px rgba(24,95,165,0.3)`,
          }}>🎯</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 4 }}>连接到 ApplyMate AI</div>
          <div style={{ fontSize: 12, color: C.muted }}>登录后自动同步所有职位</div>
        </div>

        <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Input label="邮箱" type="email"    value={email}    onChange={setEmail}    placeholder="you@example.com" />
          <Input label="密码" type="password" value={password} onChange={setPassword} placeholder="••••••••" />
          {error && (
            <div style={{ fontSize: 11, color: C.red, padding: '7px 10px', background: 'rgba(163,45,45,0.07)', borderRadius: 7, borderLeft: `3px solid ${C.red}` }}>
              {error}
            </div>
          )}
          <div style={{ marginTop: 4 }}>
            <Btn type="submit" disabled={loading} primary>{loading ? '登录中…' : '登录'}</Btn>
          </div>
        </form>

        <div style={{ fontSize: 11, color: C.muted, textAlign: 'center', marginTop: 14 }}>
          还没有账号？
          <a href={settings.apiBaseUrl} target="_blank" rel="noreferrer"
            style={{ color: C.primary, marginLeft: 4, fontWeight: 600, textDecoration: 'none' }}>
            免费注册 →
          </a>
        </div>

        <div style={{ textAlign: 'center', marginTop: 16, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
          <button
            onClick={() => {
              chrome.windows.getLastFocused().then(win => {
                if (win?.id) {
                  chrome.sidePanel.open({ windowId: win.id }).catch(() => {
                    chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html'), active: true })
                  })
                }
              })
            }}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: C.subtle, fontSize: 10, padding: '4px 8px',
              fontFamily: 'inherit',
            }}
          >
            ✨ 打开 AI 侧边栏
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main View ─────────────────────────────────────────────────

function MainView({ settings, onSettings, onLogout }: {
  settings: ExtensionSettings; onSettings: () => void; onLogout: () => void
}) {
  const [currentJob, setCurrentJob] = useState<ScrapedJob | null>(null)
  const [recentJobs, setRecentJobs] = useState<SavedJob[]>([])
  const [stats,      setStats]      = useState<DashboardStats | null>(null)
  const [saving,     setSaving]     = useState(false)
  const [savedMsg,   setSavedMsg]   = useState('')
  const [tab,        setTab]        = useState<'current' | 'recent'>('current')

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tabId = tabs[0]?.id
      if (!tabId) return
      chrome.tabs.sendMessage(tabId, { type: 'PING' }, () => {
        chrome.storage.local.get('currentJob', r => setCurrentJob(r.currentJob ?? null))
      })
    })
    chrome.runtime.sendMessage({ type: 'GET_RECENT_JOBS' }, r => setRecentJobs(r?.jobs ?? []))
    chrome.runtime.sendMessage({ type: 'GET_STATS' },       r => setStats(r?.stats ?? null))
  }, [])

  async function handleSave() {
    if (!currentJob) return
    setSaving(true)
    const res = await chrome.runtime.sendMessage({ type: 'SAVE_JOB', job: currentJob })
    setSaving(false)
    if (res?.success) {
      setSavedMsg(`✓ 已保存 — ${currentJob.company}`)
      chrome.runtime.sendMessage({ type: 'GET_RECENT_JOBS' }, r => setRecentJobs(r?.jobs ?? []))
    } else {
      setSavedMsg(`✗ ${res?.error ?? '保存失败'}`)
    }
    setTimeout(() => setSavedMsg(''), 3000)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg }}>
      <Header user={settings.userName || settings.userEmail} onSettings={onSettings} onLogout={onLogout} showSettings />

      {stats && <StatsBar stats={stats} />}

      {/* Tabs */}
      <div style={{ display: 'flex', background: C.bgCard, borderBottom: `1px solid ${C.border}`, padding: '0 12px' }}>
        {(['current', 'recent'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '9px 14px 10px', border: 'none', background: 'transparent', cursor: 'pointer',
            fontSize: 12, fontWeight: tab === t ? 600 : 400,
            color: tab === t ? C.primary : C.muted,
            borderBottom: tab === t ? `2px solid ${C.primary}` : '2px solid transparent',
            display: 'flex', alignItems: 'center', gap: 5, transition: 'all 0.12s',
          }}>
            {t === 'current' ? '当前职位' : '已保存'}
            {t === 'recent' && recentJobs.length > 0 && (
              <span style={{
                fontSize: 9, fontWeight: 700, lineHeight: '14px', padding: '0 5px',
                background: tab === 'recent' ? C.primary : C.subtle,
                color: '#fff', borderRadius: 999,
              }}>
                {recentJobs.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {tab === 'current' && (
          <CurrentJobPanel job={currentJob} saving={saving} savedMsg={savedMsg} onSave={handleSave} settings={settings} />
        )}
        {tab === 'recent' && (
          <RecentJobsList jobs={recentJobs} settings={settings} />
        )}
      </div>

      {/* Footer */}
      <div style={{ padding: '10px 12px', borderTop: `1px solid ${C.border}`, background: C.bgCard, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Btn onClick={() => {
          chrome.windows.getLastFocused().then(win => {
            if (win?.id) {
              chrome.sidePanel.open({ windowId: win.id }).catch(() => {
                chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html'), active: true })
              })
            }
          })
        }}>
          ✨ 打开 AI 侧边栏
        </Btn>
        <Btn primary onClick={() => chrome.tabs.create({ url: settings.apiBaseUrl })}>
          打开完整 Dashboard →
        </Btn>
      </div>
    </div>
  )
}

// ── Stats bar ─────────────────────────────────────────────────

function StatsBar({ stats }: { stats: DashboardStats }) {
  const items = [
    { label: '总计',  value: stats.total,      color: C.text    },
    { label: '已申请', value: stats.applied,    color: C.primary },
    { label: '面试',  value: stats.interviews,  color: C.teal    },
    { label: 'Offer', value: stats.offers,      color: C.green   },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', background: C.bgCard, borderBottom: `1px solid ${C.border}` }}>
      {items.map((s, i) => (
        <div key={s.label} style={{
          padding: '9px 0', textAlign: 'center',
          borderRight: i < 3 ? `1px solid ${C.border}` : 'none',
        }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: s.color, lineHeight: 1 }}>{s.value}</div>
          <div style={{ fontSize: 9, color: C.subtle, marginTop: 3, letterSpacing: '0.02em' }}>{s.label}</div>
        </div>
      ))}
    </div>
  )
}

// ── Current Job Panel ─────────────────────────────────────────

function CurrentJobPanel({ job, saving, savedMsg, onSave, settings }: {
  job: ScrapedJob | null; saving: boolean; savedMsg: string; onSave: () => void; settings: ExtensionSettings
}) {
  if (!job) {
    return (
      <div style={{ textAlign: 'center', padding: '24px 16px 16px', color: C.muted }}>
        <div style={{ fontSize: 38, marginBottom: 12 }}>🔍</div>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 6 }}>在此页面检测职位</div>
        <div style={{ fontSize: 11, lineHeight: 1.9, color: C.muted, marginBottom: 16 }}>
          在<strong>职位列表页</strong>，将鼠标悬停在卡片上<br />即可看到预览，点击卡片上的 <strong>⊕</strong> 按钮保存。<br /><br />
          在<strong>职位详情页</strong>，点击右上角的<br /><strong>Save to ApplyMate</strong> 按钮保存。
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
          <a href="https://www.linkedin.com/jobs/" target="_blank" rel="noreferrer"
            style={{ fontSize: 11, color: C.primary, textDecoration: 'none', fontWeight: 600 }}>
            浏览 LinkedIn Jobs →
          </a>
          <a href="https://www.indeed.com/" target="_blank" rel="noreferrer"
            style={{ fontSize: 11, color: C.muted, textDecoration: 'none' }}>
            浏览 Indeed Jobs →
          </a>
        </div>
      </div>
    )
  }

  const sm  = SOURCE_META[job.source] ?? SOURCE_META.unknown
  const sc  = sm.color

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Job card */}
      <div style={{
        background: C.bgCard, borderRadius: 10, padding: 13,
        border: `1px solid ${C.border}`, boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
      }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10, flexShrink: 0,
            background: `${sc}12`, color: sc, border: `1.5px solid ${sc}22`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700,
          }}>
            {job.company.slice(0, 2).toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3, marginBottom: 2, color: C.text }}>{job.title}</div>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>{job.company}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {job.location && <span style={{ fontSize: 10, color: C.subtle }}>📍 {job.location}</span>}
              {job.salary   && <span style={{ fontSize: 10, color: C.green, fontWeight: 500 }}>💰 {job.salary}</span>}
            </div>
          </div>
          <span style={{
            fontSize: 9, fontWeight: 700, flexShrink: 0,
            background: `${sc}12`, color: sc, borderRadius: 999, padding: '3px 8px',
          }}>
            {sm.label}
          </span>
        </div>
      </div>

      {/* Action */}
      {savedMsg ? (
        <div style={{
          textAlign: 'center', fontSize: 12, padding: '10px', fontWeight: 600, borderRadius: 8,
          color: savedMsg.startsWith('✓') ? C.green : C.red,
          background: savedMsg.startsWith('✓') ? 'rgba(59,109,17,0.08)' : 'rgba(163,45,45,0.08)',
        }}>
          {savedMsg}
        </div>
      ) : (
        <Btn onClick={onSave} disabled={saving} primary>
          {saving ? '保存中…' : '⊕ 保存到 ApplyMate'}
        </Btn>
      )}

    </div>
  )
}

// ── Recent Jobs List ──────────────────────────────────────────

function RecentJobsList({ jobs, settings }: { jobs: SavedJob[]; settings: ExtensionSettings }) {
  if (!jobs.length) {
    return (
      <div style={{ textAlign: 'center', color: C.muted, padding: '36px 16px 24px' }}>
        <div style={{ fontSize: 36, marginBottom: 10 }}>📋</div>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 6 }}>No saved jobs yet</div>
        <div style={{ fontSize: 11, lineHeight: 1.8 }}>Hover a job card and click ⊕<br />or use the top-right button on a detail page</div>
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {jobs.map(job => {
        const meta    = STATUS_META[job.status] ?? { color: C.subtle, label: job.status }
        const dateStr = formatDate(job.createdAt)
        return (
          <a
            key={job.id}
            href={`${settings.apiBaseUrl}/jobs?highlight=${job.id}`}
            target="_blank"
            rel="noreferrer"
            style={{
              background: C.bgCard, borderRadius: 9, padding: '10px 11px',
              border: `1px solid ${C.border}`, display: 'flex', gap: 9, alignItems: 'center',
              boxShadow: '0 1px 3px rgba(0,0,0,0.04)', textDecoration: 'none',
              cursor: 'pointer',
            }}
          >
            {/* Avatar */}
            <div style={{
              width: 34, height: 34, borderRadius: 8, flexShrink: 0,
              background: `${meta.color}14`, color: meta.color,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10, fontWeight: 700,
            }}>
              {job.company.slice(0, 2).toUpperCase()}
            </div>
            {/* Text */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: C.text }}>
                {job.role}
              </div>
              <div style={{ fontSize: 10, color: C.muted, display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 100 }}>{job.company}</span>
                <span style={{ color: C.subtle, flexShrink: 0 }}>·</span>
                <span style={{ color: C.subtle, flexShrink: 0 }}>{dateStr}</span>
              </div>
            </div>
            {/* Right */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, flexShrink: 0 }}>
              <span style={{
                fontSize: 9, fontWeight: 600, padding: '2px 7px',
                color: meta.color, background: `${meta.color}14`, borderRadius: 999,
              }}>
                {meta.label}
              </span>
              {job.score != null && (
                <span style={{
                  fontSize: 10, fontWeight: 700,
                  color: job.score >= 80 ? C.green : job.score >= 60 ? C.amber : C.muted,
                }}>
                  {job.score}%
                </span>
              )}
            </div>
          </a>
        )
      })}
    </div>
  )
}

// ── Settings View ─────────────────────────────────────────────

function SettingsView({ settings, refresh, onBack }: {
  settings: ExtensionSettings; refresh: () => void; onBack: () => void
}) {
  const [apiUrl, setApiUrl] = useState(settings.apiBaseUrl)
  const [saved,  setSaved]  = useState(false)

  async function handleSave() {
    await saveSettings({ apiBaseUrl: apiUrl })
    refresh()
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14, background: C.bg }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={onBack} style={{
          background: C.bgCard, border: `1px solid ${C.border}`, cursor: 'pointer',
          color: C.muted, fontSize: 16, padding: '3px 8px', borderRadius: 7, lineHeight: 1.4,
        }}>
          ←
        </button>
        <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>设置</span>
      </div>

      <Input label="后端 API 地址" type="url" value={apiUrl} onChange={setApiUrl} placeholder="http://localhost:3000" />

      <div style={{ fontSize: 11, color: C.muted, background: 'rgba(24,95,165,0.05)', padding: '9px 11px', borderRadius: 7, lineHeight: 1.8, border: `1px solid rgba(24,95,165,0.12)` }}>
        <span style={{ color: C.text, fontWeight: 600 }}>开发：</span>
        <code style={{ fontFamily: 'monospace', background: 'rgba(0,0,0,0.04)', padding: '0 4px', borderRadius: 3 }}>http://localhost:3000</code><br />
        <span style={{ color: C.text, fontWeight: 600 }}>生产：</span>
        <code style={{ fontFamily: 'monospace', background: 'rgba(0,0,0,0.04)', padding: '0 4px', borderRadius: 3 }}>https://your-domain.com</code>
      </div>

      <Btn onClick={handleSave} primary>{saved ? '✓ 已保存' : '保存设置'}</Btn>

      <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 11, color: C.muted, padding: '7px 10px', background: C.bgCard, borderRadius: 7, border: `1px solid ${C.border}` }}>
          当前账号：{settings.userEmail || '未登录'}
        </div>
        <Btn onClick={() => clearAuth().then(onBack)}>退出登录</Btn>
      </div>
    </div>
  )
}

// ── Shared components ─────────────────────────────────────────

function Header({ user, onSettings, onLogout, showSettings }: {
  user?: string; onSettings?: () => void; onLogout?: () => void; showSettings: boolean
}) {
  return (
    <div style={{
      padding: '10px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      borderBottom: `1px solid ${C.border}`, background: C.bgCard,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          width: 26, height: 26, borderRadius: 7, flexShrink: 0,
          background: `linear-gradient(135deg, ${C.primary} 0%, #2d88d4 100%)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, fontWeight: 700, color: '#fff',
          boxShadow: '0 2px 6px rgba(24,95,165,0.3)',
        }}>
          A
        </div>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, lineHeight: 1.2, color: C.text }}>ApplyMate AI</div>
          {user && <div style={{ fontSize: 9, color: C.subtle, lineHeight: 1.2 }}>{user}</div>}
        </div>
      </div>
      {showSettings && (
        <div style={{ display: 'flex', gap: 2 }}>
          <IconBtn title="设置" onClick={onSettings}>⚙</IconBtn>
          <IconBtn title="退出" onClick={onLogout}>↪</IconBtn>
        </div>
      )}
    </div>
  )
}

function IconBtn({ children, onClick, title }: {
  children: React.ReactNode; onClick?: () => void; title?: string
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      onClick={onClick} title={title}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? C.bg : 'none', border: 'none', cursor: 'pointer',
        color: hovered ? C.text : C.subtle, fontSize: 14, padding: '5px 6px',
        borderRadius: 6, lineHeight: 1, transition: 'all 0.12s',
      }}
    >
      {children}
    </button>
  )
}

function Input({ label, type, value, onChange, placeholder }: {
  label: string; type: string; value: string; onChange: (v: string) => void; placeholder?: string
}) {
  const [focused, setFocused] = useState(false)
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, color: C.muted, fontWeight: 500 }}>{label}</span>
      <input
        type={type} value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={()  => setFocused(false)}
        style={{
          padding: '8px 10px', fontSize: 12, outline: 'none',
          background: C.bgCard, color: C.text, borderRadius: 7,
          border: `1.5px solid ${focused ? C.primary : C.border}`,
          transition: 'border-color 0.15s',
          fontFamily: 'inherit',
        }}
      />
    </label>
  )
}

function Btn({ children, onClick, disabled, primary, type }: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean; primary?: boolean; type?: 'submit' | 'button'
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      type={type ?? 'button'} onClick={onClick} disabled={disabled}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: '100%', padding: '9px', border: 'none', borderRadius: 8,
        background: primary
          ? (hovered && !disabled ? C.primaryHover : C.primary)
          : (hovered ? '#d4d8e0' : C.border),
        color: primary ? '#fff' : C.text,
        fontSize: 12, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1, transition: 'all 0.12s',
        boxShadow: primary && !disabled ? '0 2px 8px rgba(24,95,165,0.25)' : 'none',
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  )
}
