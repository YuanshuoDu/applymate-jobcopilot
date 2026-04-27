import { useState, useEffect } from 'react'
import { getSettings, isLoggedIn } from '@/lib/storage'
import { updateJobStatus } from '@/lib/api'
import type { ScrapedJob, SavedJob, ExtensionSettings } from '@/lib/types'

const C = {
  primary: '#185FA5', green: '#3B6D11', red: '#A32D2D', amber: '#854F0B',
  teal: '#0E7490', bg: '#f8f9fb', bgCard: '#ffffff', border: '#e5e7ef',
  text: '#1a1a2e', muted: '#6b7280',
}

const STATUS_OPTS = [
  { value:'saved',     label:'保存',   color:C.muted    },
  { value:'applied',   label:'已申请', color:C.primary  },
  { value:'review',    label:'审核中', color:C.amber    },
  { value:'interview', label:'面试',   color:C.green    },
  { value:'offer',     label:'Offer',  color:C.teal     },
  { value:'rejected',  label:'拒绝',   color:C.red      },
]

export function SidePanel() {
  const [settings,   setSettings]   = useState<ExtensionSettings | null>(null)
  const [currentJob, setCurrentJob] = useState<ScrapedJob | null>(null)
  const [recentJobs, setRecentJobs] = useState<SavedJob[]>([])
  const [tab,        setTab]        = useState<'job' | 'recent' | 'settings'>('job')
  const [saving,     setSaving]     = useState(false)
  const [savedJob,   setSavedJob]   = useState<SavedJob | null>(null)
  const [notes,      setNotes]      = useState('')
  const [toast,      setToast]      = useState('')

  useEffect(() => {
    getSettings().then(setSettings)
    chrome.storage.local.get('currentJob', r => setCurrentJob(r.currentJob ?? null))
    chrome.runtime.sendMessage({ type: 'GET_RECENT_JOBS' }, r => setRecentJobs(r?.jobs ?? []))

    // Listen for job updates from content script
    const handler = (msg: { type: string; job?: ScrapedJob }) => {
      if (msg.type === 'JOB_SCRAPED' && msg.job) {
        setCurrentJob(msg.job)
        setSavedJob(null)
        setTab('job')
      }
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [])

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(''), 2500)
  }

  async function handleSave() {
    if (!currentJob) return
    setSaving(true)
    const res = await chrome.runtime.sendMessage({ type: 'SAVE_JOB', job: currentJob })
    setSaving(false)
    if (res?.success) {
      setSavedJob(res.savedJob)
      showToast('✓ 已保存到 ApplyMate')
      chrome.runtime.sendMessage({ type: 'GET_RECENT_JOBS' }, r => setRecentJobs(r?.jobs ?? []))
    } else {
      showToast(`✗ ${res?.error ?? '保存失败'}`)
    }
  }

  async function handleStatusChange(jobId: string, status: string) {
    if (!settings) return
    await updateJobStatus(settings, jobId, status)
    setSavedJob(prev => prev ? { ...prev, status: status as SavedJob['status'] } : prev)
    showToast(`状态更新为：${STATUS_OPTS.find(o => o.value === status)?.label}`)
  }

  if (!settings) return <div style={{ padding:20, color:C.muted }}>加载中…</div>
  if (!isLoggedIn(settings)) return <NotLoggedIn apiBase={settings.apiBaseUrl} />

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', background:C.bg }}>
      {/* Header */}
      <div style={{ padding:'12px 16px', background:C.bgCard, borderBottom:`1px solid ${C.border}`, display:'flex', alignItems:'center', gap:10 }}>
        <div style={{ width:22, height:22, borderRadius:5, background:C.primary, display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:11, fontWeight:700 }}>A</div>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:13, fontWeight:600 }}>ApplyMate AI</div>
          <div style={{ fontSize:10, color:C.muted }}>{settings.userEmail}</div>
        </div>
        <a href={settings.apiBaseUrl} target="_blank" rel="noreferrer" style={{ fontSize:11, color:C.primary, textDecoration:'none' }}>Dashboard ↗</a>
      </div>

      {/* Tabs */}
      <div style={{ display:'flex', background:C.bgCard, borderBottom:`1px solid ${C.border}` }}>
        {([['job','当前职位'],['recent','最近'],['settings','设置']] as const).map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} style={{
            flex:1, padding:'9px 0', border:'none', background:'transparent',
            fontSize:12, fontWeight: tab===t ? 600 : 400,
            color: tab===t ? C.primary : C.muted,
            borderBottom: tab===t ? `2px solid ${C.primary}` : '2px solid transparent',
            cursor:'pointer',
          }}>{label}</button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex:1, overflowY:'auto', padding:16 }}>
        {tab === 'job'      && <JobTab job={currentJob} saving={saving} savedJob={savedJob} notes={notes} onNotes={setNotes} onSave={handleSave} onStatusChange={handleStatusChange} />}
        {tab === 'recent'   && <RecentTab jobs={recentJobs} />}
        {tab === 'settings' && <SettingsTab settings={settings} onUpdate={s => setSettings(s)} />}
      </div>

      {/* Toast */}
      {toast && (
        <div style={{ position:'fixed', bottom:16, left:'50%', transform:'translateX(-50%)', background:'#1a1a2e', color:'#fff', padding:'8px 16px', borderRadius:8, fontSize:12, zIndex:9999, whiteSpace:'nowrap' }}>
          {toast}
        </div>
      )}
    </div>
  )
}

// ── Job Tab ───────────────────────────────────────────────────

function JobTab({ job, saving, savedJob, notes, onNotes, onSave, onStatusChange }: {
  job: ScrapedJob | null; saving: boolean; savedJob: SavedJob | null
  notes: string; onNotes: (v:string) => void
  onSave: () => void; onStatusChange: (id:string, status:string) => void
}) {
  if (!job) return (
    <div style={{ textAlign:'center', padding:'40px 0', color:C.muted }}>
      <div style={{ fontSize:36, marginBottom:12 }}>🔍</div>
      <div style={{ fontSize:13, lineHeight:1.8 }}>
        请在 LinkedIn、Indeed 或 Glassdoor<br />上打开一个职位页面
      </div>
    </div>
  )

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      {/* Job card */}
      <div style={{ background:C.bgCard, borderRadius:10, padding:14, border:`1px solid ${C.border}` }}>
        <div style={{ display:'flex', gap:12, alignItems:'flex-start', marginBottom:12 }}>
          <div style={{ width:42, height:42, borderRadius:8, background:'rgba(24,95,165,0.1)', color:C.primary, display:'flex', alignItems:'center', justifyContent:'center', fontSize:13, fontWeight:700, flexShrink:0 }}>
            {job.company.slice(0,2).toUpperCase()}
          </div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:14, fontWeight:600, lineHeight:1.3, marginBottom:3 }}>{job.title}</div>
            <div style={{ fontSize:12, color:C.muted, marginBottom:3 }}>{job.company}</div>
            {job.location && <div style={{ fontSize:11, color:C.muted }}>📍 {job.location}</div>}
            {job.salary   && <div style={{ fontSize:11, color:C.green, marginTop:2 }}>💰 {job.salary}</div>}
          </div>
          <span style={{ fontSize:10, background:'rgba(24,95,165,0.1)', color:C.primary, borderRadius:999, padding:'3px 8px' }}>{job.source}</span>
        </div>

        {/* AI Match Score — placeholder */}
        <div style={{ background:'rgba(24,95,165,0.06)', borderRadius:8, padding:'10px 12px' }}>
          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}>
            <span style={{ fontSize:11, fontWeight:500 }}>AI 匹配度</span>
            <span style={{ fontSize:13, fontWeight:700, color:C.primary }}>–</span>
          </div>
          <div style={{ height:4, background:C.border, borderRadius:2 }}>
            <div style={{ width:'0%', height:'100%', background:C.primary, borderRadius:2 }} />
          </div>
          <div style={{ fontSize:10, color:C.muted, marginTop:4 }}>连接 AI 功能后显示匹配分</div>
        </div>
      </div>

      {/* Status selector (only after saving) */}
      {savedJob && (
        <div style={{ background:C.bgCard, borderRadius:10, padding:14, border:`1px solid ${C.border}` }}>
          <div style={{ fontSize:12, fontWeight:500, marginBottom:10 }}>申请状态</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:6 }}>
            {STATUS_OPTS.map(opt => (
              <button key={opt.value} onClick={() => onStatusChange(savedJob.id, opt.value)} style={{
                padding:'7px 4px', border:`1.5px solid ${savedJob.status === opt.value ? opt.color : C.border}`,
                background: savedJob.status === opt.value ? `${opt.color}12` : 'transparent',
                borderRadius:6, fontSize:11, fontWeight: savedJob.status === opt.value ? 600 : 400,
                color: savedJob.status === opt.value ? opt.color : C.muted, cursor:'pointer',
              }}>{opt.label}</button>
            ))}
          </div>
        </div>
      )}

      {/* Notes */}
      <div style={{ background:C.bgCard, borderRadius:10, padding:14, border:`1px solid ${C.border}` }}>
        <div style={{ fontSize:12, fontWeight:500, marginBottom:8 }}>备注</div>
        <textarea
          value={notes} onChange={e => onNotes(e.target.value)}
          placeholder="记录面试题、薪资谈判、联系人…"
          style={{ width:'100%', height:80, padding:'8px 10px', border:`1px solid ${C.border}`, borderRadius:6, fontSize:12, resize:'vertical', outline:'none', fontFamily:'inherit', color:C.text }}
        />
      </div>

      {/* Save button */}
      {!savedJob ? (
        <button onClick={onSave} disabled={saving} style={{
          width:'100%', padding:'11px', background:C.primary, color:'#fff', border:'none', borderRadius:8,
          fontSize:13, fontWeight:500, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1,
        }}>
          {saving ? '保存中…' : '⊕ 保存到 ApplyMate'}
        </button>
      ) : (
        <div style={{ textAlign:'center', fontSize:12, color:C.green, fontWeight:500 }}>✓ 已保存到 ApplyMate</div>
      )}

      {/* Description preview */}
      {job.description && (
        <div style={{ background:C.bgCard, borderRadius:10, padding:14, border:`1px solid ${C.border}` }}>
          <div style={{ fontSize:12, fontWeight:500, marginBottom:8 }}>职位描述</div>
          <div style={{ fontSize:11, color:C.muted, lineHeight:1.7, maxHeight:200, overflowY:'auto', whiteSpace:'pre-wrap' }}>
            {job.description.slice(0, 800)}{job.description.length > 800 ? '…' : ''}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Recent Tab ────────────────────────────────────────────────

function RecentTab({ jobs }: { jobs: SavedJob[] }) {
  if (!jobs.length) return <div style={{ textAlign:'center', color:C.muted, padding:'40px 0', fontSize:13 }}>暂无保存记录</div>
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
      {jobs.map(job => {
        const sOpt = STATUS_OPTS.find(o => o.value === job.status)
        return (
          <div key={job.id} style={{ background:C.bgCard, borderRadius:10, padding:12, border:`1px solid ${C.border}` }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:8 }}>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:13, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{job.role}</div>
                <div style={{ fontSize:11, color:C.muted }}>{job.company}</div>
                {job.location && <div style={{ fontSize:10, color:C.muted, marginTop:2 }}>📍 {job.location}</div>}
              </div>
              <span style={{ fontSize:10, background:`${sOpt?.color ?? C.muted}18`, color: sOpt?.color ?? C.muted, borderRadius:999, padding:'3px 8px', flexShrink:0 }}>
                {sOpt?.label}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Settings Tab ──────────────────────────────────────────────

function SettingsTab({ settings, onUpdate }: { settings: ExtensionSettings; onUpdate: (s: ExtensionSettings) => void }) {
  const [apiUrl, setApiUrl] = useState(settings.apiBaseUrl)
  const [saved,  setSaved]  = useState(false)

  async function handleSave() {
    const next = { ...settings, apiBaseUrl: apiUrl }
    const { saveSettings } = await import('@/lib/storage')
    await saveSettings(next)
    onUpdate(next)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      <Section title="后端地址">
        <input
          type="url" value={apiUrl} onChange={e => setApiUrl(e.target.value)}
          style={{ width:'100%', padding:'9px 11px', border:`1px solid ${C.border}`, borderRadius:7, fontSize:12, color:C.text, outline:'none' }}
        />
        <div style={{ fontSize:11, color:C.muted, marginTop:6 }}>开发时填 http://localhost:3000</div>
        <button onClick={handleSave} style={{ marginTop:10, padding:'8px 14px', background:C.primary, color:'#fff', border:'none', borderRadius:6, fontSize:12, cursor:'pointer' }}>
          {saved ? '✓ 已保存' : '保存'}
        </button>
      </Section>

      <Section title="账号">
        <div style={{ fontSize:12, color:C.muted, marginBottom:8 }}>{settings.userEmail || '未登录'}</div>
        <button
          onClick={async () => { const { clearAuth } = await import('@/lib/storage'); await clearAuth() }}
          style={{ padding:'7px 14px', background:'transparent', border:`1px solid ${C.border}`, borderRadius:6, fontSize:12, cursor:'pointer', color:C.text }}
        >
          退出登录
        </button>
      </Section>

      <Section title="版本">
        <div style={{ fontSize:11, color:C.muted }}>ApplyMate AI Extension v0.1.0</div>
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background:C.bgCard, borderRadius:10, padding:14, border:`1px solid ${C.border}` }}>
      <div style={{ fontSize:12, fontWeight:600, marginBottom:10, color:C.text }}>{title}</div>
      {children}
    </div>
  )
}

function NotLoggedIn({ apiBase }: { apiBase: string }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100vh', gap:12, padding:24, textAlign:'center' }}>
      <div style={{ fontSize:40 }}>🔐</div>
      <div style={{ fontSize:14, fontWeight:600 }}>请先登录</div>
      <div style={{ fontSize:12, color:C.muted, lineHeight:1.6 }}>在插件弹窗里输入你的<br />ApplyMate 账号</div>
      <a href={apiBase} target="_blank" rel="noreferrer" style={{ padding:'9px 20px', background:C.primary, color:'#fff', borderRadius:8, textDecoration:'none', fontSize:12, fontWeight:500 }}>
        打开 ApplyMate →
      </a>
    </div>
  )
}
