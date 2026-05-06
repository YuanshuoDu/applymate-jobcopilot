/**
 * ApplyMate AI — Side Panel
 *
 * Design philosophy:
 *  • Sidebar = job TRACKER (list of saved jobs, status management)
 *  • Deliberately different from the hover popup (which is a lightweight preview)
 *  • Think: a mini Kanban / CRM panel anchored to the side of the browser
 */
import { useState, useEffect, useRef } from 'react'
import { getSettings, isLoggedIn } from '@/lib/storage'
import { updateJobStatus, updateJobNotes } from '@/lib/api'
import type { SavedJob, ExtensionSettings } from '@/lib/types'

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  primary:  '#185FA5',
  green:    '#3B6D11',
  red:      '#A32D2D',
  amber:    '#854F0B',
  teal:     '#0E7490',
  bg:       '#f0f4f8',
  card:     '#ffffff',
  border:   '#e2e8f0',
  text:     '#0f172a',
  muted:    '#64748b',
  subtle:   '#94a3b8',
}

const STATUS_OPTS = [
  { value: 'saved',     label: '已存',   color: C.subtle  },
  { value: 'applied',   label: '已申请', color: C.primary },
  { value: 'review',    label: '审核中', color: C.amber   },
  { value: 'interview', label: '面试',   color: C.teal    },
  { value: 'offer',     label: 'Offer',  color: C.green   },
  { value: 'rejected',  label: '已拒绝', color: C.red     },
]

function statusColor(s: string) { return STATUS_OPTS.find(o => o.value === s)?.color ?? C.subtle }
function statusLabel(s: string) { return STATUS_OPTS.find(o => o.value === s)?.label ?? s }

// ── Root ──────────────────────────────────────────────────────────────────────

export function SidePanel() {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null)

  useEffect(() => { getSettings().then(setSettings) }, [])

  if (!settings) return <Spinner />
  if (!isLoggedIn(settings)) return <NotLoggedIn apiBase={settings.apiBaseUrl} />

  return <TrackerPanel settings={settings} />
}

// ── Main tracker panel ────────────────────────────────────────────────────────

function TrackerPanel({ settings }: { settings: ExtensionSettings }) {
  const [jobs,        setJobs]        = useState<SavedJob[]>([])
  const [loading,     setLoading]     = useState(true)
  const [expandedId,  setExpandedId]  = useState<string | null>(null)
  const [filterStatus, setFilter]     = useState<string>('all')
  const [toast,       setToast]       = useState('')

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(''), 2500) }

  const loadJobs = () => {
    chrome.runtime.sendMessage({ type: 'GET_RECENT_JOBS' }, r => {
      setJobs(r?.jobs ?? [])
      setLoading(false)
    })
  }

  useEffect(() => {
    loadJobs()
    // Refresh when a new job is saved from content script
    const handler = (msg: { type: string }) => {
      if (msg.type === 'JOB_SCRAPED' || msg.type === 'JOB_SAVED') loadJobs()
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [])

  const filtered = filterStatus === 'all' ? jobs : jobs.filter(j => j.status === filterStatus)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: C.bg, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>

      {/* ── Header ── */}
      <div style={{ background: C.primary, padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 28, height: 28, borderRadius: 7, background: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#fff' }}>A</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', lineHeight: 1.2 }}>ApplyMate</div>
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', lineHeight: 1.2 }}>{jobs.length} 个职位已跟踪</div>
          </div>
        </div>
        <a href={settings.apiBaseUrl} target="_blank" rel="noreferrer"
          style={{ fontSize: 11, color: 'rgba(255,255,255,0.8)', textDecoration: 'none', background: 'rgba(255,255,255,0.15)', padding: '4px 8px', borderRadius: 5 }}>
          Web 端 ↗
        </a>
      </div>

      {/* ── Status filter strip ── */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '0 12px', display: 'flex', gap: 2, overflowX: 'auto' }}>
        {[{ value: 'all', label: '全部' }, ...STATUS_OPTS].map(opt => (
          <button key={opt.value} onClick={() => setFilter(opt.value)} style={{
            padding: '8px 10px', border: 'none', background: 'transparent', cursor: 'pointer',
            fontSize: 11, fontWeight: filterStatus === opt.value ? 600 : 400, whiteSpace: 'nowrap',
            color: filterStatus === opt.value ? C.primary : C.muted,
            borderBottom: filterStatus === opt.value ? `2px solid ${C.primary}` : '2px solid transparent',
            transition: 'all 0.1s',
          }}>
            {'color' in opt ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: (opt as typeof STATUS_OPTS[0]).color, display: 'inline-block' }} />
                {opt.label}
              </span>
            ) : opt.label}
          </button>
        ))}
      </div>

      {/* ── Job list ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 10px' }}>
        {loading ? (
          <Spinner />
        ) : filtered.length === 0 ? (
          <EmptyState filter={filterStatus} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {filtered.map(job => (
              <JobCard
                key={job.id}
                job={job}
                expanded={expandedId === job.id}
                onToggle={() => setExpandedId(prev => prev === job.id ? null : job.id)}
                settings={settings}
                onStatusChange={async (id, status) => {
                  await updateJobStatus(settings, id, status)
                  setJobs(prev => prev.map(j => j.id === id ? { ...j, status: status as SavedJob['status'] } : j))
                  showToast(`状态 → ${statusLabel(status)}`)
                }}
                showToast={showToast}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Footer ── */}
      <div style={{ background: C.card, borderTop: `1px solid ${C.border}`, padding: '10px 12px', display: 'flex', gap: 8 }}>
        <button onClick={loadJobs} style={{
          flex: 1, padding: '8px', background: C.bg, border: `1px solid ${C.border}`,
          borderRadius: 6, fontSize: 11, cursor: 'pointer', color: C.muted,
        }}>↺ 刷新</button>
        <button onClick={() => chrome.tabs.create({ url: settings.apiBaseUrl })} style={{
          flex: 2, padding: '8px', background: C.primary, border: 'none',
          borderRadius: 6, fontSize: 11, fontWeight: 500, cursor: 'pointer', color: '#fff',
        }}>完整管理界面 →</button>
      </div>

      {/* ── Toast ── */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 60, left: '50%', transform: 'translateX(-50%)',
          background: '#1a1a2e', color: '#fff', padding: '7px 14px',
          borderRadius: 8, fontSize: 11, zIndex: 9999, whiteSpace: 'nowrap',
          boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
        }}>
          {toast}
        </div>
      )}
    </div>
  )
}

// ── Job card (expandable) ─────────────────────────────────────────────────────

function JobCard({ job, expanded, onToggle, settings, onStatusChange, showToast }: {
  job: SavedJob
  expanded: boolean
  onToggle: () => void
  settings: ExtensionSettings
  onStatusChange: (id: string, status: string) => void
  showToast: (msg: string) => void
}) {
  const sColor = statusColor(job.status)
  const sLabel = statusLabel(job.status)
  const [notes, setNotes]           = useState(job.notes ?? '')
  const [notesSaving, setNSaving]   = useState(false)
  const notesTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Auto-save notes with debounce
  useEffect(() => {
    if (!expanded) return
    if (notesTimer.current) clearTimeout(notesTimer.current)
    notesTimer.current = setTimeout(async () => {
      setNSaving(true)
      try { await updateJobNotes(settings, job.id, notes) }
      finally { setNSaving(false) }
    }, 1200)
    return () => { if (notesTimer.current) clearTimeout(notesTimer.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes])

  return (
    <div style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, overflow: 'hidden', transition: 'box-shadow 0.15s' }}>

      {/* ── Card header (always visible) ── */}
      <div
        onClick={onToggle}
        style={{ padding: '11px 12px', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'flex-start' }}
      >
        {/* Company logo */}
        <div style={{
          width: 36, height: 36, borderRadius: 8, flexShrink: 0,
          background: `${sColor}18`, color: sColor,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, fontWeight: 700,
        }}>
          {job.company.slice(0, 2).toUpperCase()}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.text, lineHeight: 1.3, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {job.role}
          </div>
          <div style={{ fontSize: 11, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {job.company}{job.location ? ` · ${job.location}` : ''}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
          <span style={{ fontSize: 10, fontWeight: 500, color: sColor, background: `${sColor}14`, borderRadius: 999, padding: '2px 7px' }}>
            {sLabel}
          </span>
          {job.score != null && (
            <span style={{ fontSize: 11, fontWeight: 700, color: job.score >= 80 ? C.green : job.score >= 60 ? C.amber : C.red }}>
              {job.score}%
            </span>
          )}
          <span style={{ fontSize: 9, color: C.subtle }}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* ── Expanded detail ── */}
      {expanded && (
        <div style={{ borderTop: `1px solid ${C.border}`, padding: '12px 12px', display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Status selector */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>申请状态</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {STATUS_OPTS.map(opt => (
                <button key={opt.value} onClick={() => onStatusChange(job.id, opt.value)} style={{
                  padding: '5px 10px', borderRadius: 999, border: `1.5px solid ${job.status === opt.value ? opt.color : C.border}`,
                  background: job.status === opt.value ? `${opt.color}14` : 'transparent',
                  color: job.status === opt.value ? opt.color : C.muted,
                  fontSize: 11, fontWeight: job.status === opt.value ? 600 : 400, cursor: 'pointer',
                }}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Notes */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
              <span>备注</span>
              {notesSaving && <span style={{ textTransform: 'none', fontWeight: 400 }}>保存中…</span>}
              {!notesSaving && notes && <span style={{ color: C.green, textTransform: 'none', fontWeight: 400 }}>✓ 已保存</span>}
            </div>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="记录面试题、薪资、联系人…"
              style={{
                width: '100%', height: 70, padding: '7px 9px', resize: 'vertical',
                border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 11,
                fontFamily: 'inherit', color: C.text, outline: 'none', background: C.bg,
              }}
            />
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8 }}>
            {job.url && (
              <a href={job.url} target="_blank" rel="noreferrer" style={{
                flex: 1, padding: '7px 0', textAlign: 'center', background: C.bg,
                border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 11,
                color: C.primary, textDecoration: 'none',
              }}>
                查看原帖 ↗
              </a>
            )}
            <a href={`${settings.apiBaseUrl}?job=${job.id}`} target="_blank" rel="noreferrer" style={{
              flex: 1, padding: '7px 0', textAlign: 'center', background: C.primary,
              borderRadius: 6, fontSize: 11, fontWeight: 500, color: '#fff', textDecoration: 'none',
            }}>
              详细编辑 →
            </a>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ filter }: { filter: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 16px', color: C.muted }}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>
        {filter === 'all' ? '📋' : '🔍'}
      </div>
      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6, color: C.text }}>
        {filter === 'all' ? '还没有保存的职位' : `没有「${statusLabel(filter)}」的职位`}
      </div>
      <div style={{ fontSize: 11, lineHeight: 1.7 }}>
        {filter === 'all'
          ? '在 LinkedIn 或 Indeed 上悬停职位卡片\n点击 ⊕ 按钮保存'
          : '换个状态看看，或在搜索页面保存新职位'}
      </div>
    </div>
  )
}

// ── Not logged in ─────────────────────────────────────────────────────────────

function NotLoggedIn({ apiBase }: { apiBase: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: 14, padding: 28, textAlign: 'center', background: C.bg }}>
      <div style={{ width: 52, height: 52, borderRadius: 14, background: C.primary, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, color: '#fff' }}>A</div>
      <div>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6, color: C.text }}>ApplyMate AI</div>
        <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.7 }}>请先在插件弹窗中登录<br />才能使用职位跟踪功能</div>
      </div>
      <a href={apiBase} target="_blank" rel="noreferrer" style={{
        padding: '10px 24px', background: C.primary, color: '#fff',
        borderRadius: 8, textDecoration: 'none', fontSize: 12, fontWeight: 500,
      }}>
        打开 ApplyMate →
      </a>
    </div>
  )
}

// ── Spinner ───────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200 }}>
      <div style={{ width: 20, height: 20, border: `2px solid ${C.border}`, borderTopColor: C.primary, borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}
