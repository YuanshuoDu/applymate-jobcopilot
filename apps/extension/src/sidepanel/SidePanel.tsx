/**
 * ApplyMate AI — Side Panel
 *
 * Jobs is intentionally a compact companion to the web Dashboard + My Jobs:
 * a small momentum overview sits above the searchable application tracker.
 * The other tabs stay mounted after their first visit so their existing state
 * and form-filling flow are preserved.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  Ban,
  BarChart3,
  Bookmark,
  ChevronDown,
  Check,
  Download,
  ExternalLink,
  FileText,
  LoaderCircle,
  Mail,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Tags,
  MessageSquare,
  Sparkles,
  Target,
  X,
} from 'lucide-react'
import { getCurrentJob } from '@/lib/storage'
import { isSameJob } from '@/lib/job-identity'
import {
  exportApplicationPackLocally,
  getDashboard,
  prepareApplicationPack,
  scoreSavedJob,
  updateJobNotes,
} from '@/lib/api'
import { getSettings, isLoggedIn } from '@/lib/storage'
import { FormFillerView } from './FormFillerView'
import { PersonaView } from './PersonaView'
import { ResumeView } from './ResumeView'
import type { DashboardSnapshot } from '@/lib/api'
import type { ExtensionSettings, SavedJob, ScrapedJob } from '@/lib/types'
import type { FormFieldSchema } from '@/lib/form-filler/types'
import { scoreToneFor } from '@/lib/score-colors'
import './sidepanel.css'

type ExtLang = 'en' | 'de' | 'fr' | 'es' | 'nl' | 'zh'
type TabId = 'jobs' | 'form' | 'resume' | 'persona'
type FilterStatus = 'all' | 'saved' | 'applied' | 'interview' | 'rejected'
type SortBy = 'date' | 'company' | 'score'

type Labels = {
  saved: string
  applied: string
  interview: string
  rejected: string
  today: string
  yesterday: string
  daysAgo: (n: number) => string
  jobs: string
  form: string
  persona: string
  resume: string
  noJobs: string
  openDashboard: string
  notLoggedIn: string
  loginPrompt: string
}

const EXT_LABELS: Record<ExtLang, Labels> = {
  en: { saved: 'Saved', applied: 'Applied', interview: 'Interview', rejected: 'Rejected', today: 'Today', yesterday: 'Yesterday', daysAgo: n => `${n}d ago`, jobs: 'Jobs', form: 'Form Fill', persona: 'Profile', resume: 'Resume', noJobs: 'No saved jobs yet.', openDashboard: 'Open Dashboard', notLoggedIn: 'Not logged in', loginPrompt: 'Sign in to ApplyMate to use the extension.' },
  de: { saved: 'Gespeichert', applied: 'Beworben', interview: 'Gespräch', rejected: 'Abgelehnt', today: 'Heute', yesterday: 'Gestern', daysAgo: n => `vor ${n} Tagen`, jobs: 'Jobs', form: 'Formular', persona: 'Profil', resume: 'Lebenslauf', noJobs: 'Noch keine gespeicherten Jobs.', openDashboard: 'Dashboard öffnen', notLoggedIn: 'Nicht eingeloggt', loginPrompt: 'Melde dich bei ApplyMate an.' },
  fr: { saved: 'Sauvegardé', applied: 'Postulé', interview: 'Entretien', rejected: 'Refusé', today: "Aujourd'hui", yesterday: 'Hier', daysAgo: n => `il y a ${n}j`, jobs: 'Offres', form: 'Formulaire', persona: 'Profil', resume: 'CV', noJobs: "Aucune offre sauvegardée.", openDashboard: 'Ouvrir le tableau de bord', notLoggedIn: 'Non connecté', loginPrompt: 'Connectez-vous à ApplyMate.' },
  es: { saved: 'Guardado', applied: 'Aplicado', interview: 'Entrevista', rejected: 'Rechazado', today: 'Hoy', yesterday: 'Ayer', daysAgo: n => `hace ${n}d`, jobs: 'Empleos', form: 'Formulario', persona: 'Perfil', resume: 'CV', noJobs: 'No hay empleos guardados.', openDashboard: 'Abrir panel', notLoggedIn: 'No conectado', loginPrompt: 'Inicia sesión en ApplyMate.' },
  nl: { saved: 'Opgeslagen', applied: 'Gesolliciteerd', interview: 'Gesprek', rejected: 'Afgewezen', today: 'Vandaag', yesterday: 'Gisteren', daysAgo: n => `${n}d geleden`, jobs: 'Vacatures', form: 'Formulier', persona: 'Profiel', resume: 'CV', noJobs: 'Geen opgeslagen vacatures.', openDashboard: 'Dashboard openen', notLoggedIn: 'Niet ingelogd', loginPrompt: 'Meld je aan bij ApplyMate.' },
  zh: { saved: '已保存', applied: '已申请', interview: '面试', rejected: '已拒绝', today: '今天', yesterday: '昨天', daysAgo: n => `${n}天前`, jobs: '职位', form: '自动填表', persona: '画像', resume: '简历', noJobs: '暂无保存的职位。', openDashboard: '打开控制台', notLoggedIn: '未登录', loginPrompt: '请登录 ApplyMate 以使用扩展。' },
}

function getLang(): ExtLang {
  try {
    const stored = localStorage.getItem('applymate_lang') as ExtLang | null
    if (stored && stored in EXT_LABELS) return stored
    const browser = navigator.language?.slice(0, 2).toLowerCase()
    if (browser in EXT_LABELS) return browser as ExtLang
  } catch { /* extension storage may be unavailable during first paint */ }
  return 'en'
}

function useExtLang(): Labels {
  const [lang, setLang] = useState<ExtLang>(getLang)
  useEffect(() => {
    const id = window.setInterval(() => {
      const next = getLang()
      setLang(current => current === next ? current : next)
    }, 2000)
    return () => window.clearInterval(id)
  }, [])
  return EXT_LABELS[lang]
}

function formatDate(iso: string, L: Labels): string {
  const date = new Date(iso)
  const diff = Math.floor((Date.now() - date.getTime()) / 86400000)
  if (diff === 0) return L.today
  if (diff === 1) return L.yesterday
  if (diff > 1 && diff < 7) return L.daysAgo(diff)
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function formatSyncAge(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ago`
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function syncErrorMessage(error: unknown, fallback: string): string {
  const message = errorMessage(error, fallback)
  if (/401|unauthorized|not logged in|session expired|reconnect/i.test(message)) return 'Session expired — open Dashboard to reconnect.'
  if (/timeout|timed out|network|fetch/i.test(message)) return 'Connection interrupted — your last synced data is still shown.'
  return message
}

function companyInitials(company: string): string {
  const words = company.trim().split(/\s+/).filter(Boolean)
  if (words.length > 1) return `${words[0][0]}${words[1][0]}`.toUpperCase()
  return company.slice(0, 2).toUpperCase() || 'A'
}

function statusColor(status: string): string {
  return { saved: '#8995B2', applied: '#5146E5', interview: '#0E9FBD', rejected: '#CF3151', offer: '#28A66F' }[status] ?? '#8995B2'
}

function visibleStatus(status: string): FilterStatus {
  // The web workspace no longer exposes legacy Offer or In Review buckets.
  // Normalize old records into the current five-state workflow without adding
  // either legacy state back to the UI or API mutation contract.
  return status === 'offer' || status === 'review' ? 'applied' : (status as FilterStatus)
}

export function SidePanel() {
  const L = useExtLang()
  const [settings, setSettings] = useState<ExtensionSettings | null>(null)
  const [activeTab, setActiveTab] = useState<TabId>('jobs')
  const [mountedTabs, setMountedTabs] = useState<Set<TabId>>(() => new Set(['jobs']))
  const [personaUpdateTrigger, setPersonaUpdateTrigger] = useState(0)
  const [pendingFormFields, setPendingFormFields] = useState<FormFieldSchema[] | null>(null)
  const [lastTabUrl, setLastTabUrl] = useState('')
  const [scanTrigger, setScanTrigger] = useState(0)

  useEffect(() => {
    getSettings().then(setSettings)
    const onChange = (changes: { settings?: chrome.storage.StorageChange }, area: string) => {
      if (area === 'sync' && changes.settings) getSettings().then(setSettings)
    }
    chrome.storage.onChanged.addListener(onChange)
    return () => chrome.storage.onChanged.removeListener(onChange)
  }, [])

  useEffect(() => {
    async function checkCurrentTab() {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
      if (tabs[0]?.url && tabs[0].url !== lastTabUrl) {
        setLastTabUrl(tabs[0].url)
        setPendingFormFields(null)
        setScanTrigger(current => current + 1)
      }
    }
    const onActivated = () => void checkCurrentTab()
    const onUpdated = (_tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (changeInfo.url || changeInfo.status === 'complete') void checkCurrentTab()
    }
    chrome.tabs.onActivated.addListener(onActivated)
    chrome.tabs.onUpdated.addListener(onUpdated)
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated)
      chrome.tabs.onUpdated.removeListener(onUpdated)
    }
  }, [lastTabUrl])

  useEffect(() => {
    type FormMessage = { type?: string; fields?: FormFieldSchema[] }
    const handler = (message: FormMessage) => {
      if (message.type !== 'FORM_DETECTED' || !message.fields) return
      setPendingFormFields(message.fields)
      setMountedTabs(previous => new Set(previous).add('form'))
      setActiveTab('form')
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [])

  useEffect(() => {
    type PanelNavigationMessage = { type?: string; tab?: TabId }
    let hasAppliedPendingTab = false
    const selectRequestedTab = (message: PanelNavigationMessage) => {
      if (message.type !== 'OPEN_SIDE_PANEL_TAB' || (message.tab !== 'jobs' && message.tab !== 'resume')) return
      hasAppliedPendingTab = true
      setMountedTabs(previous => new Set(previous).add(message.tab!))
      setActiveTab(message.tab)
    }
    chrome.runtime.onMessage.addListener(selectRequestedTab)
    const onPendingTabChange = (changes: { pendingSidePanelTab?: chrome.storage.StorageChange }, area: string) => {
      if (area !== 'local' || !changes.pendingSidePanelTab) return
      const pending = changes.pendingSidePanelTab.newValue as { tab?: unknown; createdAt?: unknown } | string | undefined
      const tab = typeof pending === 'string' ? pending : pending?.tab
      const createdAt = typeof pending === 'object' ? pending.createdAt : undefined
      if (typeof createdAt === 'number' && Date.now() - createdAt >= 30_000) return
      if (tab === 'jobs' || tab === 'resume') {
        selectRequestedTab({ type: 'OPEN_SIDE_PANEL_TAB', tab })
        void chrome.storage.local.remove('pendingSidePanelTab')
      }
    }
    chrome.storage.onChanged.addListener(onPendingTabChange)
    chrome.storage.local.get('pendingSidePanelTab').then(result => {
      const pending = result.pendingSidePanelTab as { tab?: unknown; createdAt?: unknown } | string | undefined
      const tab = typeof pending === 'string' ? pending : pending?.tab
      const createdAt = typeof pending === 'object' ? pending.createdAt : undefined
      const fresh = typeof createdAt !== 'number' || Date.now() - createdAt < 30_000
      if (!hasAppliedPendingTab && fresh && (tab === 'jobs' || tab === 'resume')) selectRequestedTab({ type: 'OPEN_SIDE_PANEL_TAB', tab })
      void chrome.storage.local.remove('pendingSidePanelTab')
    }).catch(() => {})
    return () => {
      chrome.runtime.onMessage.removeListener(selectRequestedTab)
      chrome.storage.onChanged.removeListener(onPendingTabChange)
    }
  }, [])

  if (!settings) return <Spinner />
  if (!isLoggedIn(settings)) return <NotLoggedIn apiBase={settings.apiBaseUrl} />

  const tabs: Array<{ id: TabId; label: string }> = [
    { id: 'jobs', label: L.jobs },
    { id: 'form', label: L.form },
    { id: 'resume', label: L.resume },
    { id: 'persona', label: L.persona },
  ]
  const selectTab = (tab: TabId) => {
    setMountedTabs(previous => new Set(previous).add(tab))
    setActiveTab(tab)
  }

  return (
    <div className="am-sidepanel">
      <header className="am-topbar">
        <div className="am-brand">
          <span className="am-brand-mark" aria-hidden="true">A</span>
          <span className="am-brand-name">ApplyMate AI</span>
        </div>
        <button className="am-dashboard-link" type="button" onClick={() => chrome.tabs.create({ url: settings.apiBaseUrl })}>
          {L.openDashboard} <ArrowRight size={12} aria-hidden="true" />
        </button>
      </header>
      <nav className="am-tabs" aria-label="ApplyMate navigation">
        {tabs.map(tab => (
          <button key={tab.id} className="am-tab" type="button" role="tab" aria-selected={activeTab === tab.id} onClick={() => selectTab(tab.id)}>
            {tab.label}
          </button>
        ))}
      </nav>
      <div className="am-panel-body">
        {mountedTabs.has('jobs') && <div hidden={activeTab !== 'jobs'}><TrackerPanel settings={settings} tabKey={lastTabUrl} L={L} onOpenResume={() => selectTab('resume')} /></div>}
        {mountedTabs.has('form') && <div hidden={activeTab !== 'form'}><FormFillerView settings={settings} pendingFields={pendingFormFields} onFieldsConsumed={() => setPendingFormFields(null)} scanTrigger={scanTrigger} personaUpdateTrigger={personaUpdateTrigger} onPersonaUpdated={() => setPersonaUpdateTrigger(current => current + 1)} /></div>}
        {mountedTabs.has('resume') && <div hidden={activeTab !== 'resume'}><ResumeView settings={settings} /></div>}
        {mountedTabs.has('persona') && <div hidden={activeTab !== 'persona'}><PersonaView settings={settings} personaUpdateTrigger={personaUpdateTrigger} /></div>}
      </div>
    </div>
  )
}

function CurrentPageBanner({ accountKey, tabKey, userEmail, onSaved }: { accountKey: string; tabKey: string; userEmail: string; onSaved: () => void }) {
  const [currentJob, setCurrentJob] = useState<ScrapedJob | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState('')
  const latestDetectedAt = useRef(0)
  const currentJobRef = useRef<ScrapedJob | null>(null)

  useEffect(() => {
    // A shared storage account switch must not retain the previous account's
    // saved-state marker for the same job on the current page.
    setSaved(false)
    setSaveError('')
    setCurrentJob(null)
    currentJobRef.current = null
    latestDetectedAt.current = 0
    const readActiveTabJob = async (): Promise<ScrapedJob | null> => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
      const tabId = tabs[0]?.id
      if (tabId == null) return getCurrentJob(userEmail)
      const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_CURRENT_JOB' }).catch(() => null) as { type?: string; job?: ScrapedJob | null } | null
      if (response?.type === 'CURRENT_JOB_RESULT') return response.job ?? null
      return getCurrentJob(userEmail)
    }
    const syncSavedState = (job: ScrapedJob | null) => {
      if (!job) {
        setSaved(false)
        return
      }
      chrome.runtime.sendMessage({ type: 'GET_RECENT_JOBS' }).then(response => {
        if (Array.isArray(response?.jobs)) {
          const jobs = response.jobs as SavedJob[]
          if (currentJobRef.current !== job) return
          setSaved(jobs.some(savedJob => isSameJob(job, { source: savedJob.source ?? undefined, url: savedJob.url ?? undefined, role: savedJob.role, company: savedJob.company, location: savedJob.location ?? undefined })))
        }
      }).catch(() => {})
    }
    if (currentJobRef.current) syncSavedState(currentJobRef.current)
    const acceptJob = (job?: ScrapedJob | null) => {
      const detectedAt = job?.detectedAt ?? 0
      if (detectedAt < latestDetectedAt.current) return
      latestDetectedAt.current = detectedAt
      currentJobRef.current = job ?? null
      setCurrentJob(job ?? null)
      setSaved(false)
      setSaveError('')
      syncSavedState(job ?? null)
    }
    void readActiveTabJob().then(acceptJob)
    const handler = (message: { type?: string; job?: ScrapedJob; savedJob?: SavedJob }) => {
      if (message.type === 'JOB_SCRAPED') void readActiveTabJob().then(acceptJob)
      if (message.type === 'JOB_SAVED' && message.savedJob && currentJobRef.current && isSameJob(currentJobRef.current, { source: message.savedJob.source ?? undefined, url: message.savedJob.url ?? undefined, role: message.savedJob.role, company: message.savedJob.company, location: message.savedJob.location ?? undefined })) setSaved(true)
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [accountKey, tabKey, userEmail])

  if (!currentJob) return null

  async function saveCurrentJob() {
    setSaving(true)
    setSaveError('')
    try {
      const response = await chrome.runtime.sendMessage({ type: 'SAVE_JOB', job: currentJob }) as { success?: boolean; error?: string } | undefined
      if (response?.success) {
        setSaved(true)
        onSaved()
      } else {
        setSaveError(response?.error ?? 'Could not save this job. Try again.')
      }
    } catch (error) {
      setSaveError(errorMessage(error, 'Could not save this job. Try again.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="am-current-page" aria-label="Current page job">
      <div className="am-current-page-head"><Sparkles size={11} aria-hidden="true" /><span>Current job detected</span><span>{currentJob.source !== 'unknown' ? currentJob.source : ''}</span></div>
      <div className="am-current-page-body">
        <span className="am-company-mark" aria-hidden="true">{companyInitials(currentJob.company)}</span>
        <div className="am-current-copy"><div className="am-current-title">{currentJob.title}</div><div className="am-current-company">{currentJob.company}{currentJob.location && currentJob.location !== 'Unknown' ? ` · ${currentJob.location}` : ''}</div></div>
        <button className="am-save-button" type="button" disabled={saving || saved} onClick={() => void saveCurrentJob()}>{saved ? 'Saved' : saving ? 'Saving…' : 'Save job'}</button>
      </div>
      {saveError && <div className="am-current-error" role="alert">{saveError}</div>}
    </section>
  )
}

type LType = Labels

function TrackerPanel({ settings, tabKey, L, onOpenResume }: { settings: ExtensionSettings; tabKey: string; L: LType; onOpenResume: () => void }) {
  const [jobs, setJobs] = useState<SavedJob[]>([])
  const [dashboard, setDashboard] = useState<DashboardSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all')
  const [filterSource, setFilterSource] = useState('all')
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<SortBy>('date')
  const [scoringId, setScoringId] = useState<string | null>(null)
  const [toast, setToast] = useState('')
  const [jobsSyncError, setJobsSyncError] = useState('')
  const [dashboardSyncError, setDashboardSyncError] = useState('')
  const [lastJobsSyncedAt, setLastJobsSyncedAt] = useState<number | null>(null)
  const [lastDashboardSyncedAt, setLastDashboardSyncedAt] = useState<number | null>(null)
  const jobsRequestId = useRef(0)
  const dashboardRequestId = useRef(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  function showToast(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(current => current === message ? '' : current), 2600)
  }

  function loadJobs(showSpinner = false) {
    const requestId = ++jobsRequestId.current
    if (showSpinner) setLoading(true)
    const timeout = window.setTimeout(() => {
      if (requestId !== jobsRequestId.current) return
      setLoading(false)
      setJobsSyncError('Connection timed out — your last synced data is still shown.')
    }, 20000)
    chrome.runtime.sendMessage({ type: 'GET_RECENT_JOBS' }, (response: { jobs?: SavedJob[]; error?: string } | undefined) => {
      window.clearTimeout(timeout)
      if (requestId !== jobsRequestId.current) return
      const runtimeError = chrome.runtime.lastError?.message
      const responseError = response?.error
      if (runtimeError || responseError || !Array.isArray(response?.jobs)) {
        setJobsSyncError(syncErrorMessage(runtimeError ?? responseError, 'Could not sync jobs — your last synced data is still shown.'))
        setLoading(false)
        return
      }
      setJobs(response.jobs)
      setJobsSyncError('')
      setLastJobsSyncedAt(Date.now())
      setLoading(false)
    })
  }

  async function loadDashboard() {
    const requestId = ++dashboardRequestId.current
    try {
      const next = await getDashboard(settings)
      if (requestId !== dashboardRequestId.current) return
      setDashboard(next)
      setDashboardSyncError('')
      setLastDashboardSyncedAt(Date.now())
    } catch (error) {
      if (requestId !== dashboardRequestId.current) return
      setDashboardSyncError(syncErrorMessage(error, 'Could not sync Dashboard stats — your last synced data is still shown.'))
    }
  }

  function refreshAll(showSpinner = false) {
    loadJobs(showSpinner)
    void loadDashboard()
  }

  function focusJob(jobId: string) {
    if (!filtered.some(job => job.id === jobId)) {
      setFilterStatus('all')
      setFilterSource('all')
      setSearch('')
    }
    setExpandedId(jobId)
    window.setTimeout(() => {
      const target = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-job-id]') ?? [])
        .find(node => node.dataset.jobId === jobId)
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 0)
  }

  useEffect(() => {
    setJobs([])
    setDashboard(null)
    setExpandedId(null)
    setJobsSyncError('')
    setDashboardSyncError('')
    setLastJobsSyncedAt(null)
    setLastDashboardSyncedAt(null)
    refreshAll(true)
    const handler = (message: { type?: string }) => {
      if (message.type === 'JOB_SCRAPED' || message.type === 'JOB_SAVED' || message.type === 'JOB_MATCHED') {
        refreshAll()
      }
    }
    chrome.runtime.onMessage.addListener(handler)
    const syncTimer = window.setInterval(() => {
      refreshAll()
    }, 30000)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshAll()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.clearInterval(syncTimer)
      chrome.runtime.onMessage.removeListener(handler)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
    // Reload both the list and dashboard snapshot whenever the shared account
    // token changes so an account switch cannot retain the previous user's data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.apiBaseUrl, settings.apiToken, settings.userEmail])

  const availableSources = useMemo(() => Array.from(new Set(jobs.map(job => job.source).filter((source): source is string => Boolean(source && source !== 'unknown')))).sort(), [jobs])
  const counts = useMemo(() => {
    const result: Record<FilterStatus, number> = { all: jobs.length, saved: 0, applied: 0, interview: 0, rejected: 0 }
    for (const job of jobs) {
      const status = visibleStatus(job.status)
      if (status in result && status !== 'all') result[status] += 1
    }
    return result
  }, [jobs])
  const filtered = useMemo(() => {
    let list = filterStatus === 'all' ? [...jobs] : jobs.filter(job => visibleStatus(job.status) === filterStatus)
    if (filterSource !== 'all') list = list.filter(job => job.source === filterSource)
    const query = search.trim().toLowerCase()
    if (query) list = list.filter(job => job.role.toLowerCase().includes(query) || job.company.toLowerCase().includes(query))
    if (sortBy === 'company') list.sort((a, b) => a.company.localeCompare(b.company))
    else if (sortBy === 'score') list.sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    else list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    return list
  }, [jobs, filterStatus, filterSource, search, sortBy])

  const savedCount = dashboard?.stats.saved ?? counts.saved
  const appliedCount = dashboard?.stats.applied ?? counts.applied
  const interviewCount = dashboard?.stats.interviews ?? counts.interview
  const rejectedCount = dashboard?.stats.rejected ?? counts.rejected
  const weeklyApplications = dashboard?.stats.thisWeek ?? 0
  const weeklyTarget = 30
  const weeklyProgress = Math.min(weeklyApplications / weeklyTarget * 100, 100)
  const highMatchThreshold = dashboard?.minMatchScore ?? 75
  const highMatch = jobs.filter(job => job.score != null && job.score >= highMatchThreshold).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] ?? null
  const highMatchTone = highMatch ? scoreToneFor(highMatch.score ?? 0) : null
  const unscoredCount = jobs.filter(job => job.score == null).length

  async function scoreJob(job: SavedJob) {
    if (scoringId) return
    setScoringId(job.id)
    try {
      const updated = await scoreSavedJob(settings, job)
      setJobs(previous => previous.map(item => item.id === job.id ? { ...item, ...updated, score: updated.score } : item))
      void chrome.runtime.sendMessage({ type: 'JOB_MATCHED', job: updated })
      showToast(`${job.score == null ? 'Match score ready' : 'Match score updated'} · ${updated.score}%`)
    } catch (error) {
      if (/add a resume/i.test(error instanceof Error ? error.message : String(error))) onOpenResume()
      showToast(error instanceof Error ? error.message : 'Scoring failed')
    } finally {
      setScoringId(null)
    }
  }

  return (
    <div className="am-tracker">
      <div className="am-tracker-scroll">
        <section className="am-overview" aria-label="Application overview">
          <div className="am-overview-grid">
            <div className="am-overview-cell">
              <div className="am-overview-label"><Target size={12} aria-hidden="true" /><span>Application momentum</span></div>
              <div className="am-momentum-summary"><div className="am-momentum-ring" style={{ '--am-progress-angle': `${weeklyProgress * 3.6}deg` } as React.CSSProperties} aria-label={`${Math.round(weeklyProgress)}% of weekly target`}><strong>{Math.round(weeklyProgress)}%</strong><small>{Math.min(weeklyApplications, weeklyTarget)} / {weeklyTarget}</small></div><div className="am-momentum-copy"><strong>{weeklyApplications >= weeklyTarget ? 'Goal reached!' : 'Keep it up!'}</strong><span>{Math.max(1, 7 - new Date().getDay())} days left</span></div></div>
            </div>
            <div className="am-overview-cell">
              <div className="am-overview-label"><BarChart3 size={12} aria-hidden="true" /><span>Next step</span></div>
              <div className="am-overview-copy">{!dashboard?.hasResume ? 'Add your resume to unlock match scoring.' : unscoredCount > 0 ? `${unscoredCount} saved role${unscoredCount === 1 ? '' : 's'} ready to score.` : `${Math.max(0, weeklyTarget - weeklyApplications)} applications this week to stay on track.`}</div>
              <div className="am-progress-bar" aria-hidden="true"><span style={{ width: `${weeklyProgress}%` }} /></div>
              <button className="am-overview-action" type="button" onClick={() => dashboard?.hasResume ? (unscoredCount ? void scoreJob(jobs.find(job => job.score == null)!) : chrome.tabs.create({ url: `${settings.apiBaseUrl}/?page=jobs` })) : onOpenResume()}>{!dashboard?.hasResume ? 'Add resume' : unscoredCount ? 'Score a role' : 'View plan'}</button>
            </div>
            <div className="am-overview-cell">
              <div className="am-overview-label"><Sparkles size={12} aria-hidden="true" /><span>High match opportunity</span></div>
              {highMatch ? <div className="am-highlight"><div className="am-highlight-main"><span className="am-highlight-mark">{companyInitials(highMatch.company)}</span><div className="am-highlight-copy"><div className="am-highlight-role" title={highMatch.role}>{highMatch.role}</div><div className="am-highlight-company" title={highMatch.company}>{highMatch.company}</div></div></div><div className="am-highlight-actions"><span className={`am-highlight-score ${highMatchTone}`}>{highMatch.score}% match</span><button className="am-action-link" type="button" onClick={() => focusJob(highMatch.id)}>View job <ArrowRight size={10} aria-hidden="true" /></button></div></div> : <div className="am-overview-copy">Score a saved role to see your strongest match here.</div>}
            </div>
          </div>
        </section>

        <div className="am-stat-grid" aria-label="Application counts">
          <StatCard className="saved" label="Saved" value={savedCount} icon={<Bookmark size={13} />} />
          <StatCard className="applied" label="Applied" value={appliedCount} icon={<Send size={13} />} />
          <StatCard className="interview" label="Interviews" value={interviewCount} icon={<MessageSquare size={13} />} />
          <StatCard className="rejected" label="Rejected" value={rejectedCount} icon={<Ban size={13} />} />
        </div>

        <div className="am-job-tools">
          <div className="am-search-wrap"><label className="am-search"><Search size={15} aria-hidden="true" /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search by role or company…" aria-label="Search jobs" />{search && <button className="am-search-clear" type="button" onClick={() => setSearch('')} aria-label="Clear search"><X size={13} /></button>}</label></div>
          <div className="am-filter-strip" role="tablist" aria-label="Job status filters">
            {([['all', 'All'], ['saved', L.saved], ['applied', L.applied], ['interview', 'Interviews'], ['rejected', L.rejected]] as const).map(([value, label]) => <button key={value} className={`am-filter${filterStatus === value ? ' active' : ''}`} type="button" role="tab" aria-selected={filterStatus === value} onClick={() => setFilterStatus(value)}>{label}</button>)}
          </div>
          <div className="am-select-row"><select className="am-select" value={filterSource} onChange={event => setFilterSource(event.target.value)} aria-label="Filter by source"><option value="all">All sources</option>{availableSources.map(source => <option key={source} value={source}>{source}</option>)}</select><select className="am-select" value={sortBy} onChange={event => setSortBy(event.target.value as SortBy)} aria-label="Sort jobs"><option value="date">Newest first</option><option value="company">Company</option><option value="score">Match score</option></select></div>
        </div>

        {(jobsSyncError || dashboardSyncError) && <div className="am-sync-banner" role="alert"><div><strong>Sync needs attention</strong><span>{jobsSyncError || dashboardSyncError}</span>{(jobsSyncError ? lastJobsSyncedAt : lastDashboardSyncedAt) && <small>Last synced {formatSyncAge((jobsSyncError ? lastJobsSyncedAt : lastDashboardSyncedAt)!)}</small>}</div><button type="button" onClick={() => refreshAll(true)}>Retry</button></div>}
        <CurrentPageBanner accountKey={`${settings.apiBaseUrl}|${settings.apiToken}|${settings.userEmail}`} tabKey={tabKey} userEmail={settings.userEmail} onSaved={() => refreshAll()} />
        <div className="am-list" ref={listRef}>
          {loading ? <div className="am-spinner"><LoaderCircle className="am-spin" size={20} aria-label="Loading jobs" /></div> : filtered.length === 0 ? <EmptyState hasSearch={Boolean(search.trim())} filter={filterStatus} connectionError={Boolean(jobsSyncError)} onRetry={() => refreshAll(true)} onClearSearch={() => setSearch('')} onOpenDashboard={() => chrome.tabs.create({ url: `${settings.apiBaseUrl}/?page=jobs` })} L={L} /> : <div className="am-list-inner">{filtered.map(job => <JobCard key={job.id} job={job} expanded={expandedId === job.id} onToggle={() => setExpandedId(current => current === job.id ? null : job.id)} settings={settings} L={L} scoring={scoringId === job.id} onScore={() => void scoreJob(job)} onPrepared={() => void refreshAll(true)} />)}</div>}
        </div>
      </div>
      <footer className="am-footer"><button className="am-footer-button" type="button" onClick={() => refreshAll(true)}><RefreshCw size={12} aria-hidden="true" /> Refresh</button><button className="am-footer-button primary" type="button" onClick={() => chrome.tabs.create({ url: `${settings.apiBaseUrl}/?page=jobs` })}>View all jobs <ArrowRight size={12} aria-hidden="true" /></button></footer>
      {toast && <div className="am-toast" role="status">{toast}</div>}
    </div>
  )
}

function StatCard({ className, label, value, icon }: { className: string; label: string; value: number; icon: React.ReactNode }) {
  return <div className={`am-stat ${className}`}><div className="am-stat-head">{icon}<span>{label}</span></div><div className="am-stat-value">{value}</div></div>
}

function keyTagsForJob(job: SavedJob): string[] {
  const seen = new Set<string>()
  return (job.keywords ?? '')
    .split(/[\n,;|]+/)
    .map(value => value.trim())
    .filter(value => {
      const normalized = value.toLocaleLowerCase()
      if (!value || seen.has(normalized)) return false
      seen.add(normalized)
      return true
    })
    .slice(0, 8)
}

function statusLabel(status: string, L: Labels): string {
  return ({ saved: L.saved, applied: L.applied, interview: 'Interview', rejected: L.rejected, offer: L.applied } as Record<string, string>)[status] ?? status
}

function JobCard({ job, expanded, onToggle, settings, onScore, scoring, onPrepared, L }: {
  job: SavedJob
  expanded: boolean
  onToggle: () => void
  settings: ExtensionSettings
  onScore: () => void
  scoring: boolean
  onPrepared: () => void
  L: Labels
}) {
  const [notes, setNotes] = useState(job.notes ?? '')
  const [notesSaving, setNotesSaving] = useState(false)
  const [notesError, setNotesError] = useState('')
  const [packExporting, setPackExporting] = useState(false)
  const [packError, setPackError] = useState('')
  const [packPreparing, setPackPreparing] = useState(false)
  const [packStage, setPackStage] = useState<'resume' | 'coverLetter' | 'audit' | null>(null)
  const initialNotes = useRef(job.notes ?? '')
  const notesTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const displayStatus = visibleStatus(job.status)
  const keyTags = keyTagsForJob(job)
  const scoreTone = job.score == null ? 'normal' : scoreToneFor(job.score)

  useEffect(() => {
    const nextNotes = job.notes ?? ''
    setNotes(nextNotes)
    initialNotes.current = nextNotes
    setNotesError('')
  }, [job.id, job.notes])
  useEffect(() => {
    if (!expanded || notes === initialNotes.current) return
    if (notesTimer.current) clearTimeout(notesTimer.current)
    notesTimer.current = setTimeout(async () => {
      setNotesSaving(true)
      try {
        await updateJobNotes(settings, job.id, notes)
        initialNotes.current = notes
        setNotesError('')
      } catch {
        setNotesError('Could not save note')
      } finally {
        setNotesSaving(false)
      }
    }, 1000)
    return () => { if (notesTimer.current) clearTimeout(notesTimer.current) }
    // Debounced persistence intentionally follows the local notes field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes, expanded])

  const hasResume = Boolean(job.finalResumeId)
  const hasCoverLetter = Boolean(job.finalCoverLetterId)
  const packReady = hasResume && hasCoverLetter

  async function handlePackDownload() {
    if (!packReady || packExporting) return
    setPackExporting(true)
    setPackError('')
    try {
      const result = await exportApplicationPackLocally(settings, job.id, true)
      if (!result.opened) setPackError('Could not open the job folder')
    } catch (error) {
      setPackError(error instanceof Error ? error.message : 'Download failed')
    } finally {
      setPackExporting(false)
    }
  }

  async function handlePackPrepare() {
    if (packReady || packPreparing) return
    setPackPreparing(true)
    setPackError('')
    try {
      await prepareApplicationPack(settings, job, setPackStage)
      onPrepared()
    } catch (error) {
      setPackError(error instanceof Error ? error.message : 'Could not prepare application pack')
    } finally {
      setPackPreparing(false)
      setPackStage(null)
    }
  }

  return (
    <article className={`am-job-card${expanded ? ' expanded' : ''}`} data-job-id={job.id}>
      <div className="am-job-row">
        <span className="am-company-mark" aria-hidden="true">{companyInitials(job.company)}</span>
        <button className="am-job-main" type="button" onClick={onToggle} aria-expanded={expanded}>
          <div className="am-job-role">{job.role}</div>
          <div className="am-job-company">{job.company}{job.location ? ` · ${job.location}` : ''}</div>
          <div className="am-job-meta"><span className="am-status-pill" style={{ color: statusColor(displayStatus), background: `${statusColor(displayStatus)}14` }}><span className="am-status-dot" style={{ background: statusColor(displayStatus) }} />{statusLabel(displayStatus, L)}</span><span>·</span><span>{formatDate(job.createdAt, L)}</span></div>
          {keyTags.length > 0 && <div className="am-job-tags-preview" aria-label="Key job tags">{keyTags.slice(0, 2).map(tag => <span key={tag} className="am-job-tag-preview" title={tag}>{tag}</span>)}{keyTags.length > 2 && <span className="am-job-tag-more">+{keyTags.length - 2}</span>}</div>}
        </button>
        <div className={`am-score-box ${scoreTone}`}>
          {job.score != null ? <><div className="am-score"><div className="am-score-ring" style={{ '--am-score-angle': `${Math.max(0, Math.min(job.score, 100)) * 3.6}deg` } as React.CSSProperties} aria-label={`${job.score}% match`}><span>{job.score}</span></div><span className="am-score-label">Match</span></div><button className="am-score-action" type="button" disabled={scoring} onClick={event => { event.stopPropagation(); onScore() }}>{scoring ? '…' : 'Re-score'}</button></> : <><button className="am-score-action" type="button" disabled={scoring} onClick={event => { event.stopPropagation(); onScore() }}>{scoring ? 'Scoring…' : 'Score'}</button><span className="am-score-help">Resume + profile</span></>}
        </div>
        <button className="am-chevron" type="button" onMouseDown={event => { event.preventDefault(); event.currentTarget.blur() }} onClick={onToggle} aria-label={expanded ? `Collapse ${job.role}` : `Expand ${job.role}`}><ChevronDown size={16} className={expanded ? 'am-chevron-open' : ''} /></button>
      </div>
      {expanded && <div className="am-detail">
        <div className="am-detail-grid"><div className="am-detail-box"><div className="am-detail-label">Notes</div><div className="am-notes-meta"><span>{notesSaving ? <span className="am-saving">Saving…</span> : notesError ? <span className="am-note-error">{notesError}</span> : notes ? <span className="am-saved">Saved</span> : 'Add context for later'}</span></div><textarea className="am-notes" value={notes} onChange={event => { setNotes(event.target.value); setNotesError('') }} placeholder="Interview questions, salary, contact…" /><ApplicationPackSummary hasResume={hasResume} hasCoverLetter={hasCoverLetter} ready={packReady} preparing={packPreparing} stage={packStage} exporting={packExporting} error={packError} onPrepare={() => void handlePackPrepare()} onDownload={() => void handlePackDownload()} /></div><div className="am-detail-box am-detail-insights"><div className="am-detail-label am-detail-label-icon"><Tags size={11} aria-hidden="true" /> Key job tags</div>{keyTags.length > 0 ? <div className="am-key-tags">{keyTags.map(tag => <span key={tag} className="am-key-tag">{tag}</span>)}</div> : <div className="am-detail-text">Score this role to extract its main skills and requirements.</div>}<div className="am-detail-label am-detail-score-label">Match score</div><div className="am-detail-text">{job.score == null ? 'Not scored yet.' : `Scored at ${job.score}% against your resume.`}</div>{!job.url && <div className="am-detail-text">No original link saved.</div>}</div></div>
        <div className="am-detail-actions">{job.url && <a className="am-detail-action" href={job.url} target="_blank" rel="noreferrer">Open original <ExternalLink size={11} /></a>}<a className="am-detail-action primary" href={`${settings.apiBaseUrl}/?page=jobs&highlight=${job.id}`} target="_blank" rel="noreferrer">Open in My Jobs <ArrowRight size={11} /></a></div>
      </div>}
    </article>
  )
}

function ApplicationPackSummary({ hasResume, hasCoverLetter, ready, preparing, stage, exporting, error, onPrepare, onDownload }: {
  hasResume: boolean
  hasCoverLetter: boolean
  ready: boolean
  preparing: boolean
  stage: 'resume' | 'coverLetter' | 'audit' | null
  exporting: boolean
  error: string
  onPrepare: () => void
  onDownload: () => void
}) {
  const rows = [
    { label: 'Resume', icon: FileText, done: hasResume },
    { label: 'Cover letter', icon: Mail, done: hasCoverLetter },
    { label: 'Independent audit', icon: ShieldCheck, done: ready },
  ]

  const stageLabel = stage === 'resume' ? 'Preparing resume…' : stage === 'coverLetter' ? 'Writing cover letter…' : stage === 'audit' ? 'Running independent audit…' : 'Preparing…'
  return <div className="am-pack-summary">
    <div className="am-pack-heading"><span><Sparkles size={11} aria-hidden="true" /> Application pack</span><span className={ready ? 'am-pack-ready' : 'am-pack-pending'}>{ready ? 'Ready' : 'Pending'}</span></div>
    <div className="am-pack-rows">{rows.map(({ label, icon: Icon, done }, index) => { const active = preparing && ((stage === 'resume' && index === 0) || (stage === 'coverLetter' && index === 1) || (stage === 'audit' && index === 2)); return <div className="am-pack-row" key={label}><span className={`am-pack-icon${done ? ' done' : active ? ' active' : ''}`}><Icon size={10} aria-hidden="true" /></span><span className="am-pack-row-label">{label}</span><span className={`am-pack-status${done ? ' done' : active ? ' active' : ''}`}>{done ? <><Check size={9} /> Ready</> : active ? 'Working…' : 'Pending'}</span></div> })}</div>
    {preparing && <div className="am-pack-progress">{stageLabel}</div>}
    <div className="am-pack-actions"><button className="am-pack-prepare" type="button" disabled={ready || preparing} onClick={onPrepare}>{preparing ? stageLabel : ready ? 'Pack ready' : 'Prepare full pack'} {!ready && !preparing && <ArrowRight size={10} />}</button><button className="am-pack-download" type="button" disabled={!ready || exporting} onClick={onDownload} aria-label="Download application pack" title={ready ? 'Download application pack' : 'Complete the pack first'}><Download size={11} />{exporting ? '…' : 'Download'}</button></div>
    {error && <div className="am-pack-error" role="status">{error}</div>}
  </div>
}

function EmptyState({ hasSearch, filter, connectionError, onRetry, onClearSearch, onOpenDashboard, L }: { hasSearch: boolean; filter: FilterStatus; connectionError: boolean; onRetry: () => void; onClearSearch: () => void; onOpenDashboard: () => void; L: Labels }) {
  if (connectionError) return <div className="am-empty"><div className="am-empty-icon"><RefreshCw size={17} /></div><div className="am-empty-title">Could not sync jobs</div><div className="am-empty-copy">Your account connection needs attention. Retry or open My Jobs to continue.</div><button className="am-empty-action" type="button" onClick={onRetry}>Retry sync</button></div>
  if (hasSearch) return <div className="am-empty"><div className="am-empty-icon"><Search size={17} /></div><div className="am-empty-title">No matching jobs</div><div className="am-empty-copy">Try another role or company name.</div><button className="am-empty-action" type="button" onClick={onClearSearch}>Clear search</button></div>
  return <div className="am-empty"><div className="am-empty-icon"><Bookmark size={17} /></div><div className="am-empty-title">{filter === 'all' ? L.noJobs : `No ${filter === 'interview' ? 'interview' : filter} jobs yet`}</div><div className="am-empty-copy">Save a promising role from any supported job site and it will appear here.</div><button className="am-empty-action" type="button" onClick={onOpenDashboard}>Open My Jobs</button></div>
}

function NotLoggedIn({ apiBase }: { apiBase: string }) {
  const L = useExtLang()
  return <div className="am-sidepanel" style={{ alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24, textAlign: 'center' }}><span className="am-brand-mark" style={{ width: 48, height: 48, fontSize: 22 }} aria-hidden="true">A</span><div><div style={{ fontSize: 15, fontWeight: 750 }}>{L.notLoggedIn}</div><div style={{ marginTop: 5, color: 'var(--am-muted)', fontSize: 11, lineHeight: 1.6 }}>{L.loginPrompt}</div></div><a className="am-footer-button primary" style={{ flex: 'none', padding: '8px 14px', textDecoration: 'none' }} href={apiBase} target="_blank" rel="noreferrer">{L.openDashboard} <ArrowRight size={12} /></a></div>
}

function Spinner() {
  return <div className="am-sidepanel"><div className="am-spinner"><LoaderCircle className="am-spin" size={20} /></div></div>
}
