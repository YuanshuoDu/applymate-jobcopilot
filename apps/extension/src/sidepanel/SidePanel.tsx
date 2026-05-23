/**
 * ApplyMate AI — Side Panel
 *
 * Design philosophy:
 *  • Sidebar = job TRACKER (list of saved jobs, status management)
 *  • Deliberately different from the hover popup (which is a lightweight preview)
 *  • Think: a mini Kanban / CRM panel anchored to the side of the browser
 */
import { useState, useEffect, useRef, useMemo } from 'react'
import { getSettings, isLoggedIn } from '@/lib/storage'
import { updateJobStatus, updateJobNotes } from '@/lib/api'
import { FormFillerView } from './FormFillerView'
import { PersonaView } from './PersonaView'
import { ResumeView } from './ResumeView'
import type { SavedJob, ExtensionSettings, ScrapedJob } from '@/lib/types'
import type { FormFieldSchema } from '@/lib/form-filler/types'

// ── Design tokens (aligned with web app brand) ────────────────────────────────
const C = {
  primary:     '#4F46E5',
  accent:      '#7C3AED',
  green:       '#059669',
  red:         '#DC2626',
  amber:       '#D97706',
  teal:        '#0891B2',
  bg:          '#F8F9FF',
  bgSecondary: '#F1F3FF',
  card:        '#FFFFFF',
  border:      'rgba(99,102,241,0.15)',
  text:        '#0F172A',
  muted:       '#64748B',
  subtle:      '#94A3B8',
  gradient:    'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)',
}

// ── i18n — reads same key as web app from localStorage ───────────────────────
type ExtLang = 'en' | 'de' | 'fr' | 'es' | 'nl' | 'zh'

const EXT_LABELS: Record<ExtLang, {
  saved: string; applied: string; review: string; interview: string; offer: string; rejected: string
  today: string; yesterday: string; daysAgo: (n: number) => string
  jobs: string; form: string; persona: string; resume: string
  noJobs: string; openDashboard: string; notLoggedIn: string; loginPrompt: string
}> = {
  en: { saved: 'Saved', applied: 'Applied', review: 'In Review', interview: 'Interview', offer: 'Offer', rejected: 'Rejected', today: 'Today', yesterday: 'Yesterday', daysAgo: n => `${n}d ago`, jobs: 'Jobs', form: 'Form Fill', persona: 'Profile', resume: 'Resume', noJobs: 'No saved jobs yet.', openDashboard: 'Open Dashboard', notLoggedIn: 'Not logged in', loginPrompt: 'Sign in to ApplyMate to use the extension.' },
  de: { saved: 'Gespeichert', applied: 'Beworben', review: 'In Prüfung', interview: 'Gespräch', offer: 'Angebot', rejected: 'Abgelehnt', today: 'Heute', yesterday: 'Gestern', daysAgo: n => `vor ${n} Tagen`, jobs: 'Jobs', form: 'Formular', persona: 'Profil', resume: 'Lebenslauf', noJobs: 'Noch keine gespeicherten Jobs.', openDashboard: 'Dashboard öffnen', notLoggedIn: 'Nicht eingeloggt', loginPrompt: 'Melde dich bei ApplyMate an.' },
  fr: { saved: 'Sauvegardé', applied: 'Postulé', review: 'En cours', interview: 'Entretien', offer: 'Offre', rejected: 'Refusé', today: "Aujourd'hui", yesterday: 'Hier', daysAgo: n => `il y a ${n}j`, jobs: 'Offres', form: 'Formulaire', persona: 'Profil', resume: 'CV', noJobs: "Aucune offre sauvegardée.", openDashboard: 'Ouvrir le tableau de bord', notLoggedIn: 'Non connecté', loginPrompt: 'Connectez-vous à ApplyMate.' },
  es: { saved: 'Guardado', applied: 'Aplicado', review: 'En revisión', interview: 'Entrevista', offer: 'Oferta', rejected: 'Rechazado', today: 'Hoy', yesterday: 'Ayer', daysAgo: n => `hace ${n}d`, jobs: 'Empleos', form: 'Formulario', persona: 'Perfil', resume: 'CV', noJobs: 'No hay empleos guardados.', openDashboard: 'Abrir panel', notLoggedIn: 'No conectado', loginPrompt: 'Inicia sesión en ApplyMate.' },
  nl: { saved: 'Opgeslagen', applied: 'Gesolliciteerd', review: 'In behandeling', interview: 'Gesprek', offer: 'Aanbod', rejected: 'Afgewezen', today: 'Vandaag', yesterday: 'Gisteren', daysAgo: n => `${n}d geleden`, jobs: 'Vacatures', form: 'Formulier', persona: 'Profiel', resume: 'CV', noJobs: 'Geen opgeslagen vacatures.', openDashboard: 'Dashboard openen', notLoggedIn: 'Niet ingelogd', loginPrompt: 'Meld je aan bij ApplyMate.' },
  zh: { saved: '已保存', applied: '已申请', review: '审核中', interview: '面试', offer: 'Offer', rejected: '已拒绝', today: '今天', yesterday: '昨天', daysAgo: n => `${n}天前`, jobs: '职位', form: '自动填表', persona: '画像', resume: '简历', noJobs: '暂无保存的职位。', openDashboard: '打开控制台', notLoggedIn: '未登录', loginPrompt: '请登录 ApplyMate 以使用扩展。' },
}

function getLang(): ExtLang {
  try {
    const stored = localStorage.getItem('applymate_lang') as ExtLang | null
    if (stored && stored in EXT_LABELS) return stored
    const browser = navigator.language?.slice(0, 2).toLowerCase()
    if (browser in EXT_LABELS) return browser as ExtLang
  } catch {}
  return 'en'
}

function useExtLang() {
  const [lang, setLang] = useState<ExtLang>(getLang)
  useEffect(() => {
    // Re-check every 2s in case user changes lang in web app
    const id = setInterval(() => { const l = getLang(); setLang(l) }, 2000)
    return () => clearInterval(id)
  }, [])
  return EXT_LABELS[lang]
}

function statusColor(s: string): string {
  return { saved: C.subtle, applied: C.primary, review: C.amber, interview: C.teal, offer: C.green, rejected: C.red }[s] ?? C.subtle
}

function formatDate(iso: string, L: typeof EXT_LABELS['en']): string {
  const d    = new Date(iso)
  const now  = new Date()
  const diff = Math.floor((now.getTime() - d.getTime()) / 86400000)
  if (diff === 0) return L.today
  if (diff === 1) return L.yesterday
  if (diff < 7)  return L.daysAgo(diff)
  return d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
}

// ── Root ──────────────────────────────────────────────────────────────────────

export function SidePanel() {
  const L = useExtLang()
  const [settings, setSettings] = useState<ExtensionSettings | null>(null)
  const [activeTab, setActiveTab] = useState<'jobs' | 'form' | 'persona' | 'resume'>('jobs')
  const [personaUpdateTrigger, setPersonaUpdateTrigger] = useState(0)
  const [pendingFormFields, setPendingFormFields] = useState<FormFieldSchema[] | null>(null)
  const [lastTabUrl, setLastTabUrl] = useState('')
  const [scanTrigger, setScanTrigger] = useState(0)
  useEffect(() => {
    getSettings().then(setSettings)
    // Re-read settings whenever chrome.storage.sync changes (e.g. token synced from dashboard)
    const onChange = () => { getSettings().then(setSettings) }
    chrome.storage.onChanged.addListener(onChange)
    return () => chrome.storage.onChanged.removeListener(onChange)
  }, [])

  // Detect tab switches — reset form filler to offer re-scan on new page
  useEffect(() => {
    async function checkCurrentTab() {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
      if (tabs[0]?.url && tabs[0].url !== lastTabUrl) {
        setLastTabUrl(tabs[0].url)
        setPendingFormFields(null)  // Clear stale fields from previous page
        setScanTrigger(s => s + 1)  // Signal FormFillerView to reset
      }
    }
    const onActivated = () => checkCurrentTab()
    const onUpdated = (_tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (changeInfo.url || changeInfo.status === 'complete') checkCurrentTab()
    }
    chrome.tabs.onActivated.addListener(onActivated)
    chrome.tabs.onUpdated.addListener(onUpdated)
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated)
      chrome.tabs.onUpdated.removeListener(onUpdated)
    }
  }, [lastTabUrl])

  // Auto-switch to form filler when FORM_DETECTED message arrives
  // Store fields in state so FormFillerView can receive them after mount
  useEffect(() => {
    const handler = (msg: any) => {
      if (msg.type === 'FORM_DETECTED' && msg.fields) {
        setPendingFormFields(msg.fields)
        setActiveTab('form')
      }
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [])

  if (!settings) return <Spinner />
  if (!isLoggedIn(settings)) return <NotLoggedIn apiBase={settings.apiBaseUrl} />

  const TABS: { id: 'jobs'|'form'|'resume'|'persona'; label: string }[] = [
    { id: 'jobs',    label: L.jobs    },
    { id: 'form',    label: L.form    },
    { id: 'resume',  label: L.resume  },
    { id: 'persona', label: L.persona },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: C.bg, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      {/* Header */}
      <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}`, background: 'linear-gradient(135deg, rgba(79,70,229,0.04) 0%, rgba(124,58,237,0.03) 100%)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 26, height: 26, borderRadius: 8, background: C.gradient, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, color: '#fff', boxShadow: '0 2px 8px rgba(79,70,229,0.35)', flexShrink: 0 }}>A</div>
          <div style={{ fontSize: 12, fontWeight: 700, background: C.gradient, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>ApplyMate AI</div>
        </div>
        <button onClick={() => chrome.tabs.create({ url: settings.apiBaseUrl })} style={{ fontSize: 11, color: C.primary, background: 'rgba(79,70,229,0.08)', border: `1px solid rgba(79,70,229,0.20)`, borderRadius: 7, padding: '4px 10px', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit' }}>
          {L.openDashboard} ↗
        </button>
      </div>

      {/* Tab Bar */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${C.border}`, background: C.bg, flexShrink: 0 }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              flex: 1, padding: '9px 4px', border: 'none', background: 'none',
              fontSize: 11, fontWeight: activeTab === tab.id ? 700 : 500,
              color: activeTab === tab.id ? C.primary : C.muted,
              cursor: 'pointer',
              borderBottom: activeTab === tab.id ? `2px solid ${C.primary}` : '2px solid transparent',
              transition: 'all 0.15s', fontFamily: 'inherit',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content — all tabs kept mounted to preserve scan/fill state */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <div style={{ display: activeTab === 'jobs' ? 'block' : 'none' }}>
          <TrackerPanel settings={settings} L={L} />
        </div>
        <div style={{ display: activeTab === 'form' ? 'block' : 'none' }}>
          <FormFillerView
            settings={settings}
            pendingFields={pendingFormFields}
            onFieldsConsumed={() => setPendingFormFields(null)}
            scanTrigger={scanTrigger}
            personaUpdateTrigger={personaUpdateTrigger}
            onPersonaUpdated={() => setPersonaUpdateTrigger(t => t + 1)}
          />
        </div>
        <div style={{ display: activeTab === 'resume' ? 'block' : 'none' }}>
          <ResumeView settings={settings} />
        </div>
        <div style={{ display: activeTab === 'persona' ? 'block' : 'none' }}>
          <PersonaView settings={settings} personaUpdateTrigger={personaUpdateTrigger} />
        </div>
      </div>
    </div>
  )
}

// ── Current page banner ───────────────────────────────────────────────────────

function CurrentPageBanner({ settings, onSaved }: { settings: ExtensionSettings; onSaved: () => void }) {
  const [currentJob, setCurrentJob] = useState<ScrapedJob | null>(null)
  const [saving,     setSaving]     = useState(false)
  const [savedOk,    setSavedOk]    = useState(false)

  useEffect(() => {
    chrome.storage.local.get('currentJob', r => setCurrentJob(r.currentJob ?? null))

    const handler = (msg: { type: string; job?: ScrapedJob }) => {
      if (msg.type === 'JOB_SCRAPED') setCurrentJob(msg.job ?? null)
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [])

  if (!currentJob) return null

  const sourceColors: Record<string, string> = {
    linkedin: '#0077B5', indeed: '#003A9B', glassdoor: '#0CAA41',
    stepstone: '#E8001E', xing: '#026466', wellfound: '#333',
    greenhouse: '#3BB273', lever: '#005AFF', workday: '#F5821F',
    unknown: C.primary,
  }
  const srcColor = sourceColors[currentJob.source] ?? C.primary

  async function handleSave() {
    setSaving(true)
    try {
      const res = await chrome.runtime.sendMessage({ type: 'SAVE_JOB', job: currentJob })
        .catch(() => null) // suppress port-closed error
      if (res?.success) {
        setSavedOk(true)
        onSaved()
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{
      margin: '10px 10px 0', borderRadius: 10,
      border: `1.5px solid ${srcColor}30`,
      background: `${srcColor}06`,
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 6,
        background: `${srcColor}10`, borderBottom: `1px solid ${srcColor}20`,
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: srcColor, display: 'inline-block', flexShrink: 0 }} />
        <span style={{ fontSize: 10, fontWeight: 600, color: srcColor }}>Current Page</span>
        <span style={{ fontSize: 10, color: C.muted, marginLeft: 'auto', textTransform: 'capitalize' }}>
          {currentJob.source !== 'unknown' ? currentJob.source : ''}
        </span>
      </div>
      <div style={{ padding: '9px 10px', display: 'flex', gap: 8, alignItems: 'center' }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8, flexShrink: 0,
          background: `${srcColor}15`, color: srcColor,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 10, fontWeight: 700,
        }}>
          {currentJob.company.slice(0, 2).toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {currentJob.title}
          </div>
          <div style={{ fontSize: 10, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {currentJob.company}{currentJob.location && currentJob.location !== 'Unknown' ? ` · ${currentJob.location}` : ''}
          </div>
        </div>
        <button
          onClick={handleSave}
          disabled={saving || savedOk}
          style={{
            flexShrink: 0, padding: '5px 10px',
            background: savedOk ? '#3B6D11' : srcColor,
            color: '#fff', border: 'none', borderRadius: 7,
            fontSize: 10.5, fontWeight: 600, cursor: saving || savedOk ? 'default' : 'pointer',
            opacity: saving ? 0.7 : 1, transition: 'all 0.15s',
            fontFamily: 'inherit',
          }}
        >
          {savedOk ? '✓ Saved' : saving ? '…' : '⊕ Save'}
        </button>
      </div>
    </div>
  )
}

// ── Main tracker panel ────────────────────────────────────────────────────────

type LType = ReturnType<typeof useExtLang>

function TrackerPanel({ settings, L }: { settings: ExtensionSettings; L: LType }) {
  const [jobs,         setJobs]     = useState<SavedJob[]>([])
  const [loading,      setLoading]  = useState(true)
  const [expandedId,   setExpanded]  = useState<string | null>(null)
  const [filterStatus, setFilter]   = useState<string>('all')
  const [filterSource, setSource]   = useState<string>('all')
  const [search,       setSearch]   = useState('')
  const [sortBy,       setSortBy]   = useState<'date' | 'company' | 'score'>('date')
  const [toast,        setToast]    = useState('')

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(''), 2500) }

  const loadJobs = () => {
    chrome.runtime.sendMessage({ type: 'GET_RECENT_JOBS' }, r => {
      void chrome.runtime.lastError // suppress port-closed warning
      setJobs(r?.jobs ?? [])
      setLoading(false)
    })
  }

  useEffect(() => {
    loadJobs()
    const handler = (msg: { type: string }) => {
      if (msg.type === 'JOB_SCRAPED' || msg.type === 'JOB_SAVED') loadJobs()
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [])

  // Unique sources for filter
  const availableSources = useMemo(() => {
    const sources = new Set<string>()
    for (const j of jobs) { if (j.source && j.source !== 'unknown') sources.add(j.source) }
    return Array.from(sources).sort()
  }, [jobs])

  // Status counts for filter badges
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: jobs.length }
    for (const j of jobs) { counts[j.status] = (counts[j.status] ?? 0) + 1 }
    return counts
  }, [jobs])

  // Filtered + searched + sorted list
  const filtered = useMemo(() => {
    let list = filterStatus === 'all' ? [...jobs] : jobs.filter(j => j.status === filterStatus)
    if (filterSource !== 'all') {
      list = list.filter(j => j.source === filterSource)
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(j =>
        j.role.toLowerCase().includes(q) || j.company.toLowerCase().includes(q)
      )
    }
    // Sort
    if (sortBy === 'company') {
      list.sort((a, b) => a.company.localeCompare(b.company))
    } else if (sortBy === 'score') {
      list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    } else {
      list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    }
    return list
  }, [jobs, filterStatus, filterSource, search, sortBy])

  // Header summary stats
  const appliedCount   = jobs.filter(j => j.status === 'applied').length
  const interviewCount = jobs.filter(j => j.status === 'interview').length
  const offerCount     = jobs.filter(j => j.status === 'offer').length

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh',
      background: C.bg,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>

      {/* ── Header ── */}
      <div style={{
        background: `linear-gradient(135deg, ${C.primary} 0%, #1e7abf 100%)`,
        padding: '12px 14px',
        boxShadow: '0 2px 10px rgba(24,95,165,0.25)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 30, height: 30, borderRadius: 9, flexShrink: 0,
              background: 'rgba(255,255,255,0.2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 14, fontWeight: 700, color: '#fff',
            }}>
              A
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', lineHeight: 1.2 }}>ApplyMate</div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.65)', lineHeight: 1.2 }}>
                {jobs.length} 个职位已跟踪
              </div>
            </div>
          </div>
          <a href={settings.apiBaseUrl} target="_blank" rel="noreferrer" style={{
            fontSize: 10, color: 'rgba(255,255,255,0.9)', textDecoration: 'none',
            background: 'rgba(255,255,255,0.15)', padding: '4px 10px',
            borderRadius: 20, fontWeight: 600,
          }}>
            Dashboard ↗
          </a>
        </div>

        {/* Mini stats row */}
        <div style={{ display: 'flex', gap: 8 }}>
          {[
            { label: '申请', count: appliedCount,   bright: false },
            { label: '面试', count: interviewCount,  bright: false },
            { label: 'Offer', count: offerCount,      bright: true  },
          ].map(s => (
            <div key={s.label} style={{
              background: 'rgba(255,255,255,0.12)', borderRadius: 8,
              padding: '6px 0', flex: 1, textAlign: 'center',
            }}>
              <div style={{
                fontSize: 17, fontWeight: 700, lineHeight: 1,
                color: s.bright ? 'rgba(186,255,161,0.95)' : 'rgba(255,255,255,0.95)',
              }}>
                {s.count}
              </div>
              <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.65)', marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Search bar ── */}
      <div style={{ background: C.card, padding: '8px 12px', borderBottom: `1px solid ${C.border}` }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: '6px 10px',
        }}>
          <span style={{ fontSize: 12, color: C.subtle, flexShrink: 0 }}>🔍</span>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜索职位或公司…"
            style={{
              flex: 1, border: 'none', background: 'transparent',
              outline: 'none', fontSize: 12, color: C.text, fontFamily: 'inherit',
            }}
          />
          {search && (
            <button onClick={() => setSearch('')} style={{
              border: 'none', background: 'none', cursor: 'pointer',
              color: C.subtle, fontSize: 13, padding: '0 2px', lineHeight: 1,
            }}>
              ✕
            </button>
          )}
        </div>
      </div>

      {/* ── Status filter strip ── */}
      <div style={{
        background: C.card, borderBottom: `1px solid ${C.border}`,
        padding: '0 10px', display: 'flex', gap: 1, overflowX: 'auto',
      }}>
        {([
          { value: 'all', label: 'All', color: '' },
          { value: 'saved',     label: L.saved,     color: C.subtle  },
          { value: 'applied',   label: L.applied,   color: C.primary },
          { value: 'review',    label: L.review,    color: C.amber   },
          { value: 'interview', label: L.interview, color: C.teal    },
          { value: 'offer',     label: L.offer,     color: C.green   },
          { value: 'rejected',  label: L.rejected,  color: C.red     },
        ]).map(opt => {
          const active = filterStatus === opt.value
          const count  = statusCounts[opt.value] ?? 0
          return (
            <button key={opt.value} onClick={() => setFilter(opt.value)} style={{
              padding: '7px 8px', border: 'none', background: 'transparent', cursor: 'pointer',
              fontSize: 10.5, fontWeight: active ? 600 : 400, whiteSpace: 'nowrap',
              color: active ? C.primary : C.muted,
              borderBottom: active ? `2px solid ${C.primary}` : '2px solid transparent',
              transition: 'all 0.1s', display: 'flex', alignItems: 'center', gap: 4,
            }}>
              {opt.color && (
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: opt.color, display: 'inline-block', flexShrink: 0 }} />
              )}
              {opt.label}
              {count > 0 && (
                <span style={{
                  fontSize: 9, fontWeight: 600, lineHeight: '14px', padding: '0 4px',
                  background: active ? `rgba(24,95,165,0.12)` : C.bg,
                  color: active ? C.primary : C.subtle,
                  borderRadius: 999,
                }}>
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* ── Source filter + Sort controls ── */}
      <div style={{
        background: C.card, borderBottom: `1px solid ${C.border}`,
        padding: '5px 10px', display: 'flex', gap: 6, alignItems: 'center',
      }}>
        {/* Source filter */}
        <select value={filterSource} onChange={e => setSource(e.target.value)} style={{
          flex: 1, padding: '4px 6px', fontSize: 10.5,
          border: `1px solid ${C.border}`, borderRadius: 6,
          background: C.bg, color: C.text, fontFamily: 'inherit', outline: 'none',
          cursor: 'pointer',
        }}>
          <option value="all">所有来源</option>
          {availableSources.map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        {/* Sort */}
        <select value={sortBy} onChange={e => setSortBy(e.target.value as typeof sortBy)} style={{
          padding: '4px 6px', fontSize: 10.5,
          border: `1px solid ${C.border}`, borderRadius: 6,
          background: C.bg, color: C.text, fontFamily: 'inherit', outline: 'none',
          cursor: 'pointer',
        }}>
          <option value="date">最新</option>
          <option value="company">公司</option>
          <option value="score">匹配</option>
        </select>
      </div>

      {/* ── Current page job banner ── */}
      <CurrentPageBanner settings={settings} onSaved={loadJobs} />

      {/* ── Job list ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px' }}>
        {loading ? (
          <Spinner />
        ) : filtered.length === 0 ? (
          <EmptyState filter={filterStatus} hasSearch={!!search.trim()} onClearSearch={() => setSearch('')} L={L} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {filtered.map(job => (
              <JobCard
                key={job.id}
                job={job}
                expanded={expandedId === job.id}
                onToggle={() => setExpanded(prev => prev === job.id ? null : job.id)}
                settings={settings}
                L={L}
                onStatusChange={async (id, status) => {
                  await updateJobStatus(settings, id, status)
                  setJobs(prev => prev.map(j => j.id === id ? { ...j, status: status as SavedJob['status'] } : j))
                  showToast(`→ ${({ saved: L.saved, applied: L.applied, review: L.review, interview: L.interview, offer: L.offer, rejected: L.rejected })[status] ?? status}`)
                }}
                showToast={showToast}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Footer ── */}
      <div style={{
        background: C.card, borderTop: `1px solid ${C.border}`,
        padding: '8px 12px', display: 'flex', gap: 8,
      }}>
        <button onClick={loadJobs} style={{
          flex: 1, padding: '7px', background: C.bg,
          border: `1px solid ${C.border}`, borderRadius: 7,
          fontSize: 11, cursor: 'pointer', color: C.muted, fontFamily: 'inherit',
        }}>
          ↺ Refresh
        </button>
        <button onClick={() => chrome.tabs.create({ url: settings.apiBaseUrl })} style={{
          flex: 2, padding: '7px', background: C.primary, border: 'none',
          borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: 'pointer',
          color: '#fff', fontFamily: 'inherit',
        }}>
          {L.openDashboard} →
        </button>
      </div>

      {/* ── Toast ── */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 60, left: '50%', transform: 'translateX(-50%)',
          background: '#0f172a', color: '#fff', padding: '8px 18px',
          borderRadius: 20, fontSize: 11, zIndex: 9999, whiteSpace: 'nowrap',
          boxShadow: '0 4px 16px rgba(0,0,0,0.2)', fontWeight: 600,
        }}>
          {toast}
        </div>
      )}
    </div>
  )
}

// ── Job card (expandable) ─────────────────────────────────────────────────────

function JobCard({ job, expanded, onToggle, settings, onStatusChange, showToast, L }: {
  job: SavedJob
  expanded: boolean
  onToggle: () => void
  settings: ExtensionSettings
  onStatusChange: (id: string, status: string) => void
  showToast: (msg: string) => void
  L: LType
}) {
  const sColor = statusColor(job.status)
  const sLabel = ({ saved: L.saved, applied: L.applied, review: L.review, interview: L.interview, offer: L.offer, rejected: L.rejected })[job.status] ?? job.status
  const [notes,      setNotes]   = useState(job.notes ?? '')
  const [notesSaving, setNSaving] = useState(false)
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
    <div style={{
      background: C.card, borderRadius: 10, border: `1px solid ${C.border}`,
      overflow: 'hidden',
      boxShadow: expanded ? '0 4px 14px rgba(0,0,0,0.08)' : '0 1px 3px rgba(0,0,0,0.04)',
      transition: 'box-shadow 0.2s',
    }}>

      {/* ── Card header (always visible) ── */}
      <div
        onClick={onToggle}
        style={{ padding: '10px 12px', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'center' }}
      >
        {/* Avatar */}
        <div style={{
          width: 36, height: 36, borderRadius: 9, flexShrink: 0,
          background: `${sColor}18`, color: sColor,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, fontWeight: 700,
        }}>
          {job.company.slice(0, 2).toUpperCase()}
        </div>

        {/* Text */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 12.5, fontWeight: 600, color: C.text,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: 1.3,
          }}>
            {job.role}
          </div>
          <div style={{ fontSize: 11, color: C.muted, display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>
              {job.company}
            </span>
            <span style={{ color: C.subtle, flexShrink: 0 }}>·</span>
            <span style={{ color: C.subtle, flexShrink: 0, fontSize: 10 }}>
              {formatDate(job.createdAt, L)}
            </span>
          </div>
        </div>

        {/* Right */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
          <span style={{
            fontSize: 10, fontWeight: 600, padding: '2px 8px',
            color: sColor, background: `${sColor}14`, borderRadius: 999,
          }}>
            {sLabel}
          </span>
          {/* Quick action: mark as applied when job is saved */}
          {job.status === 'saved' && (
            <button onClick={e => { e.stopPropagation(); onStatusChange(job.id, 'applied') }} style={{
              fontSize: 9, fontWeight: 600, padding: '1px 7px',
              background: 'rgba(24,95,165,0.1)', color: C.primary,
              border: `1px solid rgba(24,95,165,0.2)`, borderRadius: 999,
              cursor: 'pointer', fontFamily: 'inherit', lineHeight: '18px',
            }}>
              {L.applied} →
            </button>
          )}
          <span style={{ fontSize: 9, color: C.subtle }}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* ── Expanded detail ── */}
      {expanded && (
        <div style={{
          borderTop: `1px solid ${C.border}`, padding: '12px',
          display: 'flex', flexDirection: 'column', gap: 12,
        }}>

          {/* Status selector */}
          <div>
            <div style={{
              fontSize: 10, fontWeight: 600, color: C.subtle,
              textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 7,
            }}>
              申请状态
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {([
                { value: 'saved',     label: L.saved,     color: C.subtle  },
                { value: 'applied',   label: L.applied,   color: C.primary },
                { value: 'review',    label: L.review,    color: C.amber   },
                { value: 'interview', label: L.interview, color: C.teal    },
                { value: 'offer',     label: L.offer,     color: C.green   },
                { value: 'rejected',  label: L.rejected,  color: C.red     },
              ]).map(opt => (
                <button key={opt.value} onClick={() => onStatusChange(job.id, opt.value)} style={{
                  padding: '4px 10px', borderRadius: 999,
                  border: `1.5px solid ${job.status === opt.value ? opt.color : C.border}`,
                  background: job.status === opt.value ? `${opt.color}14` : 'transparent',
                  color: job.status === opt.value ? opt.color : C.muted,
                  fontSize: 10.5, fontWeight: job.status === opt.value ? 600 : 400,
                  cursor: 'pointer', transition: 'all 0.1s', fontFamily: 'inherit',
                }}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Notes */}
          <div>
            <div style={{
              fontSize: 10, fontWeight: 600, color: C.subtle,
              textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span>Notes</span>
              {notesSaving ? (
                <span style={{ textTransform: 'none', fontWeight: 400, color: C.subtle, fontSize: 10 }}>Saving…</span>
              ) : notes ? (
                <span style={{ textTransform: 'none', fontWeight: 400, color: C.green, fontSize: 10 }}>✓ Saved</span>
              ) : null}
            </div>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Notes: interview questions, salary, contact…"
              style={{
                width: '100%', height: 70, padding: '7px 9px', resize: 'vertical',
                border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 11,
                fontFamily: 'inherit', color: C.text, outline: 'none',
                background: C.bg, boxSizing: 'border-box',
              }}
            />
          </div>

          {/* Salary (if available) */}
          {job.salary && (
            <div style={{
              fontSize: 11, color: C.green, fontWeight: 500,
              background: 'rgba(59,109,17,0.07)', padding: '5px 10px',
              borderRadius: 6, border: '1px solid rgba(59,109,17,0.15)',
            }}>
              💰 {job.salary}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8 }}>
            {job.url && (
              <a href={job.url} target="_blank" rel="noreferrer" style={{
                flex: 1, padding: '7px 0', textAlign: 'center',
                background: C.bg, border: `1px solid ${C.border}`, borderRadius: 7,
                fontSize: 11, color: C.primary, textDecoration: 'none', fontWeight: 500,
              }}>
                Original ↗
              </a>
            )}
            <a href={`${settings.apiBaseUrl}/jobs?highlight=${job.id}`} target="_blank" rel="noreferrer" style={{
              flex: 2, padding: '7px 0', textAlign: 'center',
              background: C.primary, borderRadius: 7,
              fontSize: 11, fontWeight: 600, color: '#fff', textDecoration: 'none',
            }}>
              {L.openDashboard} →
            </a>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ filter, hasSearch, onClearSearch, L }: {
  filter: string; hasSearch: boolean; onClearSearch: () => void; L: LType
}) {
  if (hasSearch) {
    return (
      <div style={{ textAlign: 'center', padding: '44px 16px', color: C.muted }}>
        <div style={{ fontSize: 30, marginBottom: 10 }}>🔍</div>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 8 }}>No results</div>
        <button onClick={onClearSearch} style={{
          fontSize: 11, color: C.primary, background: 'rgba(24,95,165,0.08)',
          border: `1px solid rgba(24,95,165,0.2)`, borderRadius: 6,
          cursor: 'pointer', padding: '5px 14px', fontFamily: 'inherit', fontWeight: 500,
        }}>
          Clear search
        </button>
      </div>
    )
  }
  return (
    <div style={{ textAlign: 'center', padding: '48px 16px', color: C.muted }}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: C.text }}>
        {L.noJobs}
      </div>
    </div>
  )
}

// ── Not logged in ─────────────────────────────────────────────────────────────

function NotLoggedIn({ apiBase }: { apiBase: string }) {
  const L = useExtLang()
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '100vh', gap: 18,
      padding: 28, textAlign: 'center',
      background: 'linear-gradient(160deg, #F8F9FF 0%, #EEF0FF 100%)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      <div style={{
        width: 60, height: 60, borderRadius: 18,
        background: C.gradient,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 26, fontWeight: 800, color: '#fff',
        boxShadow: '0 8px 24px rgba(79,70,229,0.40)',
      }}>A</div>
      <div>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6, color: C.text }}>{L.notLoggedIn}</div>
        <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.75, maxWidth: 220 }}>{L.loginPrompt}</div>
      </div>
      <a href={apiBase} target="_blank" rel="noreferrer" style={{
        padding: '10px 28px', background: C.gradient, color: '#fff',
        borderRadius: 11, textDecoration: 'none', fontSize: 13,
        fontWeight: 700, boxShadow: '0 4px 16px rgba(79,70,229,0.40)',
        letterSpacing: '0.01em',
      }}>
        {L.openDashboard} →
      </a>
    </div>
  )
}

// ── Spinner ───────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, flexDirection: 'column', gap: 12 }}>
      <div style={{
        width: 28, height: 28,
        border: `3px solid rgba(79,70,229,0.12)`, borderTopColor: C.primary,
        borderRadius: '50%', animation: 'sp-spin 0.7s linear infinite',
      }} />
      <style>{`@keyframes sp-spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}
