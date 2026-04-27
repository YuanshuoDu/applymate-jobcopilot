import { useState, useEffect, useCallback } from 'react'
import { getSettings, saveSettings, isLoggedIn, clearAuth } from '@/lib/storage'
import { login as apiLogin } from '@/lib/api'
import type { ExtensionSettings, ScrapedJob, SavedJob, DashboardStats } from '@/lib/types'

// ── Tokens / colours ─────────────────────────────────────────
const C = {
  primary:  '#185FA5',
  green:    '#3B6D11',
  red:      '#A32D2D',
  amber:    '#854F0B',
  bg:       '#f8f9fb',
  bgCard:   '#ffffff',
  border:   '#e5e7ef',
  text:     '#1a1a2e',
  muted:    '#6b7280',
}

const STATUS_COLOR: Record<string, string> = {
  saved:     '#6b7280',
  applied:   C.primary,
  review:    C.amber,
  interview: C.green,
  offer:     '#0E7490',
  rejected:  C.red,
}

// ── Main App ─────────────────────────────────────────────────

export function App() {
  const [settings, setSettings]   = useState<ExtensionSettings | null>(null)
  const [view,     setView]       = useState<'main' | 'login' | 'settings'>('main')
  const [loading,  setLoading]    = useState(true)

  useEffect(() => {
    getSettings().then(s => {
      setSettings(s)
      setLoading(false)
      if (!isLoggedIn(s)) setView('login')
    })
  }, [])

  const refresh = useCallback(() => {
    getSettings().then(setSettings)
  }, [])

  if (loading || !settings) return <LoadingScreen />
  if (view === 'login')    return <LoginView    settings={settings} onLogin={s => { setSettings(s); setView('main') }} />
  if (view === 'settings') return <SettingsView settings={settings} refresh={refresh} onBack={() => setView('main')} />

  return <MainView settings={settings} onSettings={() => setView('settings')} onLogout={() => { clearAuth(); setView('login') }} />
}

// ── Loading ───────────────────────────────────────────────────

function LoadingScreen() {
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:200 }}>
      <span style={{ color: C.muted, fontSize:12 }}>Loading…</span>
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
    <div style={{ padding: 20, display:'flex', flexDirection:'column', gap:16 }}>
      <Header showSettings={false} />

      <div style={{ textAlign:'center', padding:'8px 0' }}>
        <div style={{ fontSize:28, marginBottom:8 }}>🎯</div>
        <div style={{ fontSize:14, fontWeight:500, marginBottom:4 }}>连接到 ApplyMate AI</div>
        <div style={{ fontSize:12, color:C.muted }}>输入你的账号登录</div>
      </div>

      <form onSubmit={handleLogin} style={{ display:'flex', flexDirection:'column', gap:10 }}>
        <Input label="邮箱" type="email"    value={email}    onChange={setEmail}    placeholder="demo@applymate.ai" />
        <Input label="密码" type="password" value={password} onChange={setPassword} placeholder="••••••••" />
        {error && <div style={{ fontSize:11, color:C.red, padding:'6px 10px', background:'rgba(163,45,45,0.08)', borderRadius:6 }}>{error}</div>}
        <Btn type="submit" disabled={loading} primary>{loading ? '登录中…' : '登录'}</Btn>
      </form>

      <div style={{ fontSize:11, color:C.muted, textAlign:'center' }}>
        还没有账号？
        <a href={`${settings.apiBaseUrl}`} target="_blank" rel="noreferrer" style={{ color:C.primary, marginLeft:4 }}>注册</a>
      </div>
    </div>
  )
}

// ── Main View ─────────────────────────────────────────────────

function MainView({ settings, onSettings, onLogout }: {
  settings: ExtensionSettings
  onSettings: () => void
  onLogout: () => void
}) {
  const [currentJob,  setCurrentJob]  = useState<ScrapedJob | null>(null)
  const [recentJobs,  setRecentJobs]  = useState<SavedJob[]>([])
  const [stats,       setStats]       = useState<DashboardStats | null>(null)
  const [saving,      setSaving]      = useState(false)
  const [savedMsg,    setSavedMsg]    = useState('')
  const [tab,         setTab]         = useState<'current' | 'recent'>('current')

  useEffect(() => {
    // Get current page job from content script via background
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tabId = tabs[0]?.id
      if (!tabId) return
      chrome.tabs.sendMessage(tabId, { type: 'PING' }, () => {
        // If content script is alive, get current job from local storage
        chrome.storage.local.get('currentJob', r => setCurrentJob(r.currentJob ?? null))
      })
    })

    // Load recent jobs and stats
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
    <div style={{ display:'flex', flexDirection:'column', height:'100%' }}>
      <Header
        user={settings.userName || settings.userEmail}
        onSettings={onSettings}
        onLogout={onLogout}
        showSettings
      />

      {/* Stats bar */}
      {stats && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', borderBottom:`1px solid ${C.border}` }}>
          {[
            { label:'申请', value: stats.applied },
            { label:'面试', value: stats.interviews },
            { label:'Offer', value: stats.offers },
            { label:'总计', value: stats.total },
          ].map(s => (
            <div key={s.label} style={{ padding:'8px 0', textAlign:'center', borderRight:`1px solid ${C.border}` }}>
              <div style={{ fontSize:16, fontWeight:600, color: C.primary }}>{s.value}</div>
              <div style={{ fontSize:10, color:C.muted }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display:'flex', borderBottom:`1px solid ${C.border}` }}>
        {(['current','recent'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            flex:1, padding:'8px 0', border:'none', background:'transparent',
            fontSize:12, fontWeight: tab===t ? 600 : 400,
            color: tab===t ? C.primary : C.muted,
            borderBottom: tab===t ? `2px solid ${C.primary}` : '2px solid transparent',
            cursor:'pointer', transition:'all 0.1s',
          }}>
            {t === 'current' ? '当前职位' : `最近保存 (${recentJobs.length})`}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ flex:1, overflowY:'auto', padding:14 }}>
        {tab === 'current' && (
          <CurrentJobPanel job={currentJob} saving={saving} savedMsg={savedMsg} onSave={handleSave} settings={settings} />
        )}
        {tab === 'recent' && (
          <RecentJobsList jobs={recentJobs} />
        )}
      </div>

      {/* Open dashboard */}
      <div style={{ padding:'10px 14px', borderTop:`1px solid ${C.border}` }}>
        <button
          onClick={() => chrome.tabs.create({ url: settings.apiBaseUrl })}
          style={{ width:'100%', padding:'8px', background:C.primary, color:'#fff', border:'none', borderRadius:6, fontSize:12, fontWeight:500, cursor:'pointer' }}
        >
          打开 Dashboard →
        </button>
      </div>
    </div>
  )
}

function CurrentJobPanel({ job, saving, savedMsg, onSave, settings }: {
  job: ScrapedJob | null
  saving: boolean
  savedMsg: string
  onSave: () => void
  settings: ExtensionSettings
}) {
  if (!job) {
    return (
      <div style={{ textAlign:'center', padding:'24px 0', color:C.muted }}>
        <div style={{ fontSize:28, marginBottom:8 }}>🔍</div>
        <div style={{ fontSize:12, lineHeight:1.6 }}>
          请在 LinkedIn、Indeed 或 Glassdoor<br />上打开一个职位页面
        </div>
      </div>
    )
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
      <div style={{ background:C.bgCard, borderRadius:8, padding:12, border:`1px solid ${C.border}` }}>
        <div style={{ display:'flex', gap:10, alignItems:'flex-start' }}>
          <div style={{ width:36, height:36, borderRadius:7, background:'rgba(24,95,165,0.1)', color:C.primary, display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:700, flexShrink:0 }}>
            {job.company.slice(0,2).toUpperCase()}
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:13, fontWeight:600, lineHeight:1.3, marginBottom:3 }}>{job.title}</div>
            <div style={{ fontSize:12, color:C.muted }}>{job.company}</div>
            {job.location && <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>📍 {job.location}</div>}
            {job.salary   && <div style={{ fontSize:11, color:C.green, marginTop:2 }}>💰 {job.salary}</div>}
          </div>
          <span style={{ fontSize:10, background:'rgba(24,95,165,0.1)', color:C.primary, borderRadius:999, padding:'2px 7px', flexShrink:0 }}>{job.source}</span>
        </div>
      </div>

      {savedMsg ? (
        <div style={{ textAlign:'center', fontSize:12, padding:'10px 0', color: savedMsg.startsWith('✓') ? C.green : C.red, fontWeight:500 }}>
          {savedMsg}
        </div>
      ) : (
        <Btn onClick={onSave} disabled={saving} primary>
          {saving ? '保存中…' : '⊕ 保存到 ApplyMate'}
        </Btn>
      )}

      <button
        onClick={() => chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' })}
        style={{ width:'100%', padding:'8px', background:'transparent', color:C.primary, border:`1px solid ${C.primary}`, borderRadius:6, fontSize:12, fontWeight:500, cursor:'pointer' }}
      >
        打开侧边栏查看详情 ↗
      </button>
    </div>
  )
}

function RecentJobsList({ jobs }: { jobs: SavedJob[] }) {
  if (!jobs.length) {
    return <div style={{ textAlign:'center', color:C.muted, fontSize:12, padding:'20px 0' }}>暂无保存记录</div>
  }
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
      {jobs.map(job => (
        <div key={job.id} style={{ background:C.bgCard, borderRadius:8, padding:10, border:`1px solid ${C.border}` }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:8 }}>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:12, fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{job.role}</div>
              <div style={{ fontSize:11, color:C.muted }}>{job.company}</div>
            </div>
            <span style={{ fontSize:10, background: `${STATUS_COLOR[job.status]}18`, color:STATUS_COLOR[job.status], borderRadius:999, padding:'2px 7px', flexShrink:0 }}>
              {job.status}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Settings View ─────────────────────────────────────────────

function SettingsView({ settings, refresh, onBack }: { settings: ExtensionSettings; refresh: () => void; onBack: () => void }) {
  const [apiUrl, setApiUrl] = useState(settings.apiBaseUrl)
  const [saved,  setSaved]  = useState(false)

  async function handleSave() {
    await saveSettings({ apiBaseUrl: apiUrl })
    refresh()
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div style={{ padding:16, display:'flex', flexDirection:'column', gap:14 }}>
      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
        <button onClick={onBack} style={{ background:'none', border:'none', cursor:'pointer', color:C.muted, fontSize:18 }}>←</button>
        <span style={{ fontSize:14, fontWeight:600 }}>设置</span>
      </div>

      <Input label="后端 API 地址" type="url" value={apiUrl} onChange={setApiUrl} placeholder="http://localhost:3000" />

      <div style={{ fontSize:11, color:C.muted, background:'rgba(24,95,165,0.06)', padding:'8px 10px', borderRadius:6 }}>
        开发模式：<code>http://localhost:3000</code><br />
        生产模式：<code>https://your-domain.com</code>
      </div>

      <Btn onClick={handleSave} primary>{saved ? '✓ 已保存' : '保存'}</Btn>

      <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:12 }}>
        <div style={{ fontSize:12, color:C.muted, marginBottom:8 }}>当前账号：{settings.userEmail || '未登录'}</div>
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
    <div style={{ padding:'12px 14px', display:'flex', alignItems:'center', justifyContent:'space-between', borderBottom:`1px solid ${C.border}`, background:C.bgCard }}>
      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
        <div style={{ width:22, height:22, borderRadius:5, background:C.primary, display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:11, fontWeight:700 }}>A</div>
        <div>
          <div style={{ fontSize:12, fontWeight:600, lineHeight:1.2 }}>ApplyMate AI</div>
          {user && <div style={{ fontSize:10, color:C.muted, lineHeight:1.2 }}>{user}</div>}
        </div>
      </div>
      {showSettings && (
        <div style={{ display:'flex', gap:6 }}>
          <IconBtn title="设置" onClick={onSettings}>⚙</IconBtn>
          <IconBtn title="退出" onClick={onLogout}>↪</IconBtn>
        </div>
      )}
    </div>
  )
}

function IconBtn({ children, onClick, title }: { children: React.ReactNode; onClick?: () => void; title?: string }) {
  return (
    <button onClick={onClick} title={title} style={{ background:'none', border:'none', cursor:'pointer', color:C.muted, fontSize:14, padding:4, borderRadius:4, lineHeight:1 }}>
      {children}
    </button>
  )
}

function Input({ label, type, value, onChange, placeholder }: {
  label: string; type: string; value: string; onChange: (v: string) => void; placeholder?: string
}) {
  return (
    <label style={{ display:'flex', flexDirection:'column', gap:4 }}>
      <span style={{ fontSize:11, color:C.muted, fontWeight:500 }}>{label}</span>
      <input
        type={type} value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        style={{ padding:'8px 10px', border:`1px solid ${C.border}`, borderRadius:6, fontSize:12, outline:'none', background:C.bgCard, color:C.text }}
      />
    </label>
  )
}

function Btn({ children, onClick, disabled, primary, type }: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean; primary?: boolean; type?: 'submit' | 'button'
}) {
  return (
    <button
      type={type ?? 'button'} onClick={onClick} disabled={disabled}
      style={{
        width:'100%', padding:'9px', border:'none', borderRadius:6,
        background: primary ? C.primary : C.border,
        color: primary ? '#fff' : C.text,
        fontSize:12, fontWeight:500, cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1, transition:'all 0.15s',
      }}
    >
      {children}
    </button>
  )
}
