/**
 * ResumeView — Simplified resume tab for the sidebar.
 *
 * Layout (top to bottom):
 *   1. Top bar: resume selector + new + upload
 *   2. Tailor: open the shared My Jobs application-pack workflow (if job detected)
 *   3. Preview: rendered with template styling — the final look
 *   4. Template picker: style / accent color / density
 *   5. Quick Edit: collapsed by default, can add/remove sections
 *   6. Download PDF button
 *
 * Syncs bidirectionally with the web app via the REST API.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import {
  AlertTriangle,
  Check,
  Download,
  FileText,
  LoaderCircle,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  Upload,
} from 'lucide-react'
import { getCurrentJob, getCurrentResumeId, setCurrentResumeId, setResumeDraft, clearResumeDraft } from '@/lib/storage'
import {
  listResumes, getResume, updateResume, createResume,
  getRecentJobs, saveJob, tailorResume, scoreResume, exportApplicationPackLocally,
} from '@/lib/api'
import type { ExtensionSettings, ScrapedJob, ResumeListItem, Resume, ResumeContent, TemplateOptions, ScoreResult } from '@/lib/types'
import { useExtensionI18n } from '@/lib/i18n'

// ── Design tokens ────────────────────────────────────────────────────────────────
const C = {
  primary:  '#4F46E5',
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

const EMPTY_CONTENT: ResumeContent = {
  contact: { name: '', email: '', location: '' },
  summary: '',
  experience: [],
  education: [],
  skills: [],
}

function normalizeResumeContent(value: Partial<ResumeContent> | null | undefined): ResumeContent {
  return {
    ...EMPTY_CONTENT,
    ...value,
    contact: { ...EMPTY_CONTENT.contact, ...(value?.contact ?? {}) },
    experience: Array.isArray(value?.experience) ? value.experience.map(exp => ({ ...exp, bullets: Array.isArray(exp.bullets) ? exp.bullets : [] })) : [],
    education: Array.isArray(value?.education) ? value.education : [],
    skills: Array.isArray(value?.skills) ? value.skills : [],
    languages: Array.isArray(value?.languages) ? value.languages : [],
    projects: Array.isArray(value?.projects) ? value.projects.map(project => ({ ...project, bullets: Array.isArray(project.bullets) ? project.bullets : [] })) : [],
    certifications: Array.isArray(value?.certifications) ? value.certifications : [],
    custom: Array.isArray(value?.custom) ? value.custom.map(section => ({ ...section, items: Array.isArray(section.items) ? section.items.map(item => ({ ...item, bullets: Array.isArray(item.bullets) ? item.bullets : [] })) : [] })) : [],
  }
}

const TEMPLATE_NAMES: Record<string, string> = {
  clean: 'Clean', executive: 'Executive', sidebar: 'Sidebar',
  timeline: 'Timeline', compact: 'Compact',
}

const ACCENT_COLORS = [
  { v: '#4F46E5', n: 'Blue' }, { v: '#475569', n: 'Slate' },
  { v: '#2E6B4F', n: 'Forest' }, { v: '#C2410C', n: 'Terracotta' },
  { v: '#7C3AED', n: 'Violet' }, { v: '#374151', n: 'Graphite' },
]

const FONT_MAP: Record<string, string> = {
  sans: "'Inter', 'Segoe UI', Arial, sans-serif",
  serif: "'Georgia', 'Times New Roman', serif",
  mono: "'Courier New', 'Consolas', monospace",
}

const DENSITY_PAD: Record<string, string> = {
  compact: '12px 16px', comfortable: '18px 22px', spacious: '24px 28px',
}

const ALL_SECTION_IDS = ['summary','experience','skills','education','languages','projects','certifications']

// ── Props ────────────────────────────────────────────────────────────────────────
interface Props { settings: ExtensionSettings }

function sameJobUrl(left: string, right: string): boolean {
  try {
    const normalize = (value: string) => {
      const url = new URL(value)
      return `${url.origin}${url.pathname.replace(/\/$/, '')}`
    }
    return normalize(left) === normalize(right)
  } catch {
    return left === right
  }
}

// ── Root ─────────────────────────────────────────────────────────────────────────
export function ResumeView({ settings }: Props) {
  const { t } = useExtensionI18n()
  const [resumes, setResumes] = useState<ResumeListItem[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [resume, setResume] = useState<Resume | null>(null)
  const [content, setContent] = useState<ResumeContent>(EMPTY_CONTENT)
  const [templateId, setTemplateId] = useState<string | null>('clean')
  const [templateOpts, setTemplateOpts] = useState<TemplateOptions>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [toast, setToast] = useState('')
  const [editMode, setEditMode] = useState(false)
  const [currentJob, setCurrentJob] = useState<ScrapedJob | null>(null)
  const [auditedResumeId, setAuditedResumeId] = useState<string | null>(null)
  const [packageStatus, setPackageStatus] = useState<'audited' | 'missing' | null>(null)
  const [savedJobId, setSavedJobId] = useState<string | null>(null)
  const [exportedPackFolder, setExportedPackFolder] = useState<string | null>(null)
  const [exportingPack, setExportingPack] = useState(false)
  const [tailoring, setTailoring] = useState(false)
  const [tailorResult, setTailorResult] = useState<ScoreResult | null>(null)
  const [tailorError, setTailorError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [loadError, setLoadError] = useState('')

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const apiBase = settings.apiBaseUrl
  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(''), 2500) }

  // ── Init ───────────────────────────────────────────────────────────────────────
  useEffect(() => {
    loadResumeList()
    void getCurrentJob(settings.userEmail).then(job => setCurrentJob(job))
    const handler = (msg: any) => { if (msg.type === 'JOB_SCRAPED' && msg.job) setCurrentJob(msg.job) }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [settings.apiBaseUrl, settings.apiToken, settings.userEmail])

  useEffect(() => { setAuditedResumeId(null); setPackageStatus(null); setSavedJobId(null); setExportedPackFolder(null); setTailorResult(null); setTailorError('') }, [currentJob?.url])

  // A job opened in Chrome may have a different reviewed application package
  // from the last resume viewed in the extension. Prefer the final, audited
  // resume selected in My Jobs whenever the current page belongs to that job.
  useEffect(() => {
    if (!currentJob?.url || resumes.length === 0) return
    void getRecentJobs(settings).then(jobs => {
      const savedJob = jobs.find(job => job.url && sameJobUrl(job.url, currentJob.url))
      setSavedJobId(savedJob?.id ?? null)
      const auditedResumeId = savedJob?.finalResumeId
      if (!auditedResumeId || !resumes.some(item => item.id === auditedResumeId)) {
        setPackageStatus('missing')
        return
      }
      setAuditedResumeId(auditedResumeId)
      setPackageStatus('audited')
      if (auditedResumeId === activeId) return
      setActiveId(auditedResumeId)
      void loadResume(auditedResumeId)
      showToast('Using this job’s audited resume')
    }).catch(() => {
      // The extension remains usable offline or before a job has been saved.
    })
  }, [currentJob?.url, resumes, activeId, settings])

  async function loadResumeList() {
    setLoadError('')
    try {
      const list = await listResumes(settings)
      setResumes(list)
      if (list.length > 0) {
        const savedId = await getCurrentResumeId(settings.userEmail)
        const targetId = savedId && list.find(r => r.id === savedId) ? savedId : list[0].id
        setActiveId(targetId)
        await loadResume(targetId)
      } else { setLoading(false) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setLoadError(msg)
      setLoading(false)
    }
  }

  async function loadResume(id: string) {
    setLoading(true)
    try {
      const r = await getResume(settings, id)
      setResume(r)
      setContent(normalizeResumeContent(r.content))
      setTemplateId(r.templateId ?? 'clean')
      setTemplateOpts(r.templateOptions ?? {})
      setDirty(false)
      await setCurrentResumeId(id, settings.userEmail)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load'
      showToast(msg)
      setLoadError(msg)
    }
    finally { setLoading(false) }
  }

  async function handleSelect(id: string) { setActiveId(id); await loadResume(id) }
  async function handleCreate() {
    try {
      const r = await createResume(settings, { name: `Resume ${resumes.length + 1}`, content: EMPTY_CONTENT, templateId: 'clean' })
      setResumes(prev => [r, ...prev]); setActiveId(r.id); setResume(r)
      setContent(EMPTY_CONTENT); setTemplateId('clean'); setTemplateOpts({}); setDirty(false)
      await setCurrentResumeId(r.id, settings.userEmail); showToast('Created')
    } catch { showToast('Failed') }
  }

  // ── Upload resume (parse) ──────────────────────────────────────────────────────
  async function handleUpload(file: File) {
    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch(`${apiBase}/api/resume/parse`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${settings.apiToken}` },
        body: formData,
        signal: AbortSignal.timeout(120_000),
      })
      if (!res.ok) throw new Error('Upload failed')
      const parsed = await res.json()
      // Create a new resume with parsed content
      const r = await createResume(settings, {
        name: file.name.replace(/\.(pdf|docx?)$/i, ''),
        content: parsed.content ?? parsed,
        templateId: 'clean',
      })
      setResumes(prev => [r, ...prev]); setActiveId(r.id); setResume(r)
      setContent(normalizeResumeContent(r.content)); setTemplateId('clean'); setTemplateOpts({}); setDirty(false)
      await setCurrentResumeId(r.id, settings.userEmail); showToast('Resume uploaded & parsed!')
    } catch { showToast('Upload failed') }
    finally { setUploading(false) }
  }

  // ── Save ───────────────────────────────────────────────────────────────────────
  const doSave = useCallback(async (c: ResumeContent, tid: string | null, topts: TemplateOptions) => {
    if (!activeId) return
    setSaving(true)
    try {
      await updateResume(settings, activeId, { content: c, templateId: tid, templateOptions: topts })
      setDirty(false); clearResumeDraft(activeId, settings.userEmail)
    } catch { showToast('Save failed'); setResumeDraft(activeId, c, settings.userEmail) }
    finally { setSaving(false) }
  }, [settings, activeId])

  function markDirty(newContent: ResumeContent, newTid?: string | null, newTpts?: TemplateOptions) {
    setContent(newContent)
    if (newTid !== undefined) setTemplateId(newTid)
    if (newTpts !== undefined) setTemplateOpts(newTpts)
    setDirty(true)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => doSave(newContent, newTid ?? templateId, newTpts ?? templateOpts), 1200)
  }

  // ── Template ───────────────────────────────────────────────────────────────────
  function changeTemplate(tid: string | null) { markDirty(content, tid, templateOpts) }
  function changeAccent(color: string) { markDirty(content, templateId, { ...templateOpts, accentColor: color }) }
  function changeDensity(d: TemplateOptions['density']) { markDirty(content, templateId, { ...templateOpts, density: d }) }
  function changeFont(f: TemplateOptions['fontFamily']) { markDirty(content, templateId, { ...templateOpts, fontFamily: f }) }

  // ── Quick Edit: add section ────────────────────────────────────────────────────
  function addSection(sectionId: string) {
    const updated = { ...content }
    switch (sectionId) {
      case 'languages': updated.languages = [...(updated.languages ?? []), { lang: '', level: '' }]; break
      case 'projects': updated.projects = [...(updated.projects ?? []), { name: '', bullets: [] }]; break
      case 'certifications': updated.certifications = [...(updated.certifications ?? []), { name: '', issuer: '', date: '' }]; break
      case 'custom': {
        const cs = updated.custom ?? []
        const id = `custom_${Date.now()}`
        updated.custom = [...cs, { id, title: 'Custom Section', items: [] }]
        // Expand the new section in QuickEdit
        break
      }
    }
    markDirty(updated)
    showToast(`Added ${sectionId} section`)
  }

  // ── PDF ────────────────────────────────────────────────────────────────────────
  function handleOpenPrint() {
    if (!activeId) return
    chrome.tabs.create({ url: `${apiBase}/resume/${activeId}/print` })
  }

  async function handleExportApplicationPack() {
    if (!savedJobId || packageStatus !== 'audited') return handleOpenPrint()
    setExportingPack(true)
    try {
      const result = await exportApplicationPackLocally(settings, savedJobId, Boolean(exportedPackFolder))
      setExportedPackFolder(result.folderPath)
      showToast(exportedPackFolder ? 'Opened job folder' : 'Audited PDFs saved to D:')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not save application PDFs')
    } finally {
      setExportingPack(false)
    }
  }

  function handleOpenTailor() {
    void handleTailor()
  }

  async function handleTailor() {
    if (!currentJob || !activeId || tailoring) return
    setTailoring(true)
    setTailorResult(null)
    setTailorError('')
    try {
      let jobId = savedJobId
      if (!jobId) {
        const saved = await saveJob(settings, currentJob)
        jobId = saved.id
        setSavedJobId(jobId)
      }
      const result = await tailorResume(settings, jobId, activeId)
      const tailored = await getResume(settings, result.adaptedResumeId)
      await loadResume(result.adaptedResumeId)
      setAuditedResumeId(null)
      setPackageStatus('missing')
      const analysis = await scoreResume(settings, {
        resumeContent: tailored.content,
        jobTitle: currentJob.title,
        jobCompany: currentJob.company,
        jobDescription: currentJob.description,
      })
      setTailorResult(analysis)
      showToast('Resume tailored for this job')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tailoring failed'
      setTailorError(message)
      showToast(message)
    } finally {
      setTailoring(false)
    }
  }

  // ── Resolved template options ──────────────────────────────────────────────────
  const accent = templateOpts.accentColor ?? ACCENT_COLORS[0].v
  const font = FONT_MAP[templateOpts.fontFamily ?? 'sans']
  const density = templateOpts.density ?? 'comfortable'

  // ── Loading ────────────────────────────────────────────────────────────────────
  if (loading && !resume) {
    return <div className="am-resume-state am-resume-loading"><LoaderCircle size={20} className="am-spin" aria-label={t('Loading resumes')} /></div>
  }

  // ── Load error ─────────────────────────────────────────────────────────────────
  if (!loading && loadError) {
    return (
      <div className="am-resume-view am-resume-state am-resume-error">
        <div className="am-resume-state-icon danger"><AlertTriangle size={19} aria-hidden="true" /></div>
        <div className="am-resume-state-title">{t('Failed to load resumes')}</div>
        <div className="am-resume-state-copy">{loadError}</div>
        <div className="am-resume-api">API: {settings.apiBaseUrl}</div>
        <button className="am-resume-primary-button" type="button" onClick={loadResumeList}><RefreshCw size={13} aria-hidden="true" /> {t('Retry')}</button>
      </div>
    )
  }

  // ── Empty state ────────────────────────────────────────────────────────────────
  if (!loading && resumes.length === 0) {
    return (
      <div className="am-resume-view am-resume-state am-resume-empty">
        <div className="am-resume-state-icon"><FileText size={20} aria-hidden="true" /></div>
        <div className="am-resume-state-title">{t('No resumes yet')}</div>
        <div className="am-resume-state-copy">{t('Create one or upload a PDF/DOCX to get started.')}</div>
        <div className="am-resume-state-actions">
          <button className="am-resume-primary-button" type="button" onClick={handleCreate}><Plus size={13} aria-hidden="true" /> {t('Create resume')}</button>
          <button className="am-resume-secondary-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            <Upload size={13} aria-hidden="true" /> {uploading ? 'Uploading…' : 'Upload PDF/DOCX'}
          </button>
          <input ref={fileInputRef} type="file" accept=".pdf,.docx,.doc" style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f) }} />
        </div>
      </div>
    )
  }

  // ── Compute which sections are present (for preview ordering) ──────────────────
  const presentSections = ALL_SECTION_IDS.filter(id => {
    switch (id) {
      case 'languages': return (content.languages ?? []).length > 0
      case 'projects': return (content.projects ?? []).length > 0
      case 'certifications': return (content.certifications ?? []).length > 0
      default: return true
    }
  })
  const customIds = (content.custom ?? []).map(c => c.id)

  // ── Render ─────────────────────────────────────────────────────────────────────
  return (
    <div className="am-resume-view">
      {/* ════ Top Bar: Selector + New + Upload ════ */}
      <div className="am-resume-toolbar">
        <div className="am-resume-toolbar-title"><span className="am-resume-toolbar-icon"><FileText size={14} aria-hidden="true" /></span><span><small>{t('Workspace')}</small><strong>{t('Resume')}</strong></span></div>
        <select className="am-resume-select" value={activeId ?? ''} onChange={e => handleSelect(e.target.value)} style={selectStyle(C)} aria-label={t('Select resume')}>
          {resumes.map(r => (<option key={r.id} value={r.id}>{r.name}{r.isDefault ? ' ★' : ''}</option>))}
        </select>
        <button className="am-resume-icon-action" type="button" onClick={handleCreate} title={t('New resume')} aria-label={t('New resume')}><Plus size={15} aria-hidden="true" /></button>
        <button className="am-resume-upload-action" type="button" onClick={() => fileInputRef.current?.click()} title={t('Upload PDF/DOCX')}>
          <Upload size={12} aria-hidden="true" /> {uploading ? '…' : 'Upload'}
        </button>
        <input ref={fileInputRef} type="file" accept=".pdf,.docx,.doc" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); e.target.value = '' }} />
      </div>

      <div className="am-resume-content">
        {/* ══════════════════════════════════════════════════════════════════════════
            1️⃣  JOB MATCH
           ═══════════════════════════════════════════════════════════════════════ */}
        {currentJob && (
          <div className="am-resume-card am-resume-job-card">
            <div className="am-resume-job-heading">
              <div className="am-resume-job-avatar">
                {currentJob.company.slice(0, 2).toUpperCase()}
              </div>
              <div className="am-resume-job-copy">
                <span className="am-resume-eyebrow">{t('Current job')}</span>
                <div style={{ fontSize: 11, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentJob.title}</div>
                <div style={{ fontSize: 10, color: C.muted }}>{currentJob.company}{currentJob.location ? ` · ${currentJob.location}` : ''}</div>
              </div>
            </div>
            {auditedResumeId === activeId && <div style={{ margin: '0 0 9px', fontSize: 10, fontWeight: 600, color: C.green }}>✓ {t('Using the audited resume selected in My Jobs')}</div>}
            {packageStatus === 'missing' && <div style={{ margin: '0 0 9px', fontSize: 10, lineHeight: 1.4, fontWeight: 600, color: C.amber }}>{t('No tailored application pack for this job yet. Prepare it in My Jobs before submitting.')}</div>}
            <button className="am-resume-match-button" type="button" onClick={handleOpenTailor} disabled={tailoring}>
              {tailoring ? <LoaderCircle size={13} className="am-spin" aria-hidden="true" /> : <FileText size={13} aria-hidden="true" />} {tailoring ? t('Tailoring resume…') : packageStatus === 'audited' ? t('Review application pack') : t('Tailor resume')}
            </button>
            {tailorError && <div className="am-resume-tailor-error" role="alert">{tailorError}</div>}
            {tailorResult && <TailorAnalysis result={tailorResult} />}
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════════════
            2️⃣  RESUME PREVIEW — template applied, ready-to-go look
           ═══════════════════════════════════════════════════════════════════════ */}
        <div className="am-resume-card am-resume-preview-card">
          <div className="am-resume-card-head">
            <span className="am-resume-card-title"><FileText size={13} aria-hidden="true" /> {t('Resume preview')}</span>
            <button className={`am-resume-pill-action${editMode ? ' active' : ''}`} type="button" onClick={() => setEditMode(v => !v)}>
              {editMode ? <><Check size={11} aria-hidden="true" /> {t('Done')}</> : <><Pencil size={11} aria-hidden="true" /> {t('Quick edit')}</>}
            </button>
          </div>

          {editMode ? (
            <QuickEdit content={content} onChange={markDirty} settings={settings} presentSections={presentSections} onAddSection={addSection} apiBase={apiBase} />
          ) : (
            <TemplatePreview content={content} accent={accent} font={font} density={density} presentSections={presentSections} customIds={customIds} />
          )}
        </div>

        {/* ══════════════════════════════════════════════════════════════════════════
            3️⃣  TEMPLATE PICKER — with thumbnails
           ═══════════════════════════════════════════════════════════════════════ */}
        <div className="am-resume-card am-resume-template-card">
          <div className="am-resume-card-title"><Palette size={13} aria-hidden="true" /> {t('Template')}</div>

          {/* Thumbnail grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6, marginBottom: 10 }}>
            {Object.entries(TEMPLATE_NAMES).map(([id, name]) => {
              const active = templateId === id
              const useAccent = active ? accent : ACCENT_COLORS[0].v
              const useFont = active ? font : FONT_MAP.sans
              return (
                <button key={id} onClick={() => changeTemplate(id)} style={{
                  padding: 0, borderRadius: 8, border: active ? `2.5px solid ${C.primary}` : `1px solid ${C.border}`,
                  background: active ? `${C.primary}06` : C.bg,
                  cursor: 'pointer', overflow: 'hidden', fontFamily: 'inherit',
                  boxShadow: active ? `0 0 0 3px ${C.primary}18` : 'none',
                }}>
                  <TemplateThumbnail id={id} accent={useAccent} font={useFont} />
                  <div style={{
                    fontSize: 8, fontWeight: active ? 700 : 500, padding: '4px 0 5px',
                    color: active ? C.primary : C.muted, textAlign: 'center',
                  }}>{name}</div>
                </button>
              )
            })}
          </div>

          {/* Accent color + Font family */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
            {ACCENT_COLORS.map(c => (
              <button key={c.v} onClick={() => changeAccent(c.v)} title={c.n} style={{ width: 20, height: 20, borderRadius: '50%', background: c.v, border: templateOpts.accentColor === c.v ? `3px solid ${C.text}` : '2px solid transparent', cursor: 'pointer', outline: 'none', flexShrink: 0 }} />
            ))}
            <select value={templateOpts.fontFamily ?? 'sans'} onChange={e => changeFont(e.target.value as TemplateOptions['fontFamily'])} style={{ flex: 1, padding: '4px 6px', fontSize: 9, borderRadius: 5, border: `1px solid ${C.border}`, background: C.bg, color: C.text, fontFamily: 'inherit', outline: 'none', cursor: 'pointer' }}>
              <option value="sans">{t('Sans')}</option>
              <option value="serif">{t('Serif')}</option>
              <option value="mono">{t('Mono')}</option>
            </select>
          </div>

          {/* Density */}
          <select value={density} onChange={e => changeDensity(e.target.value as TemplateOptions['density'])} style={{ width: '100%', padding: '5px 8px', fontSize: 10, borderRadius: 6, border: `1px solid ${C.border}`, background: C.bg, color: C.text, fontFamily: 'inherit', outline: 'none', cursor: 'pointer' }}>
            <option value="compact">{t('Compact')}</option>
            <option value="comfortable">{t('Comfortable')}</option>
            <option value="spacious">{t('Spacious')}</option>
          </select>
        </div>

        {/* ══════════════════════════════════════════════════════════════════════════
            4️⃣  DOWNLOAD PDF (the only download entry)
           ═══════════════════════════════════════════════════════════════════════ */}
        <div className="am-resume-card am-resume-download-card">
          <div className="am-resume-card-title"><Download size={13} aria-hidden="true" /> {t('Download PDF')}</div>
          <div className="am-resume-download-copy">{packageStatus === 'audited' ? 'Saves the audited resume and cover letter into this job’s D: folder' : 'Opens print view → save as PDF → drag to upload portal'}</div>
          <button className="am-resume-download-button" type="button" onClick={handleExportApplicationPack} disabled={!activeId || exportingPack}>
            <Download size={14} aria-hidden="true" />
            {exportingPack ? 'Saving audited PDFs…' : exportedPackFolder ? 'Open job folder →' : packageStatus === 'audited' ? 'Save audited application PDFs →' : 'Print & Download PDF →'}
          </button>
        </div>

        {/* ── Sync status ── */}
        <div className="am-resume-sync">
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: dirty ? C.amber : saving ? C.subtle : C.green, display: 'inline-block' }} />
          {saving ? 'Saving...' : dirty ? 'Unsaved' : 'Synced'}
          <button type="button" onClick={() => activeId && loadResume(activeId)}><RefreshCw size={10} aria-hidden="true" /> {t('Refresh')}</button>
        </div>
      </div>

      {/* ── Toast ── */}
      {toast && (
        <div className="am-toast">{toast}</div>
      )}
    </div>
  )
}

function TailorAnalysis({ result }: { result: ScoreResult }) {
  const { t } = useExtensionI18n()
  const sections = ['Summary', 'Skills', 'Experience', 'Education', 'Projects']
  return <div className="am-resume-tailor-analysis">
    <div className="am-resume-tailor-score"><div className="am-resume-tailor-score-ring" style={{ '--am-tailor-score': `${result.score}%` } as React.CSSProperties}><strong>{result.score}%</strong></div><div><strong>{t('Match score')}</strong><span>{result.strengthSummary || t('Tailored to this role')}</span></div></div>
    <div className="am-resume-section-heading">{t('SECTION ANALYSIS')}</div>
    <div className="am-resume-section-list">{sections.map(section => {
      const score = result.sectionScores?.[section]
      const match = result.sectionMatches?.find(item => item.section === section)
      const tip = result.sectionTips?.[section]
      if (score === undefined && !match) return null
      return <div className="am-resume-section-row" key={section}><div className="am-resume-section-row-head"><span>{t(section)}</span><strong>{score ?? match?.score ?? 0}%</strong></div><div className="am-resume-section-bar"><span style={{ width: `${Math.max(0, Math.min(score ?? match?.score ?? 0, 100))}%` }} /></div>{tip && <small>{tip}</small>}</div>
    })}</div>
  </div>
}

// ── Template Preview — renders resume with template styling ──────────────────────

function TemplatePreview({ content, accent, font, density, presentSections, customIds }: {
  content: ResumeContent; accent: string; font: string; density: string
  presentSections: string[]; customIds: string[]
}) {
  const { t } = useExtensionI18n()
  const pad = DENSITY_PAD[density] ?? DENSITY_PAD.comfortable
  const sec = content

  const allIds = [...presentSections, ...customIds]
  const order = sec.sectionOrder && sec.sectionOrder.length > 0
    ? sec.sectionOrder.filter(s => allIds.includes(s))
    : allIds

  return (
    <div style={{ padding: pad, fontFamily: font, background: '#fff' }}>
      {/* ── Contact / Header ── */}
      <div style={{ textAlign: 'center', marginBottom: 14 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#1a1a1a', letterSpacing: '-0.01em' }}>{sec.contact.name || 'Your Name'}</div>
        <div style={{ fontSize: 9, color: '#666', marginTop: 3, display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '0 2px', lineHeight: 1.8 }}>
          {[sec.contact.email, sec.contact.phone, sec.contact.location].filter(Boolean).map((p, i, arr) => (
            <span key={i}>{p}{i < arr.length - 1 ? <span style={{ margin: '0 6px', opacity: 0.3 }}>·</span> : null}</span>
          ))}
        </div>
        {(sec.contact.linkedin || sec.contact.github || sec.contact.website) && (
          <div style={{ fontSize: 9, color: '#888', marginTop: 1 }}>
            {[sec.contact.linkedin, sec.contact.github, sec.contact.website].filter(Boolean).join(' · ')}
          </div>
        )}
      </div>

      {/* ── Sections in order ── */}
      {order.map(sectionId => (
        <div key={sectionId} style={{ marginBottom: 12 }}>
          <PreviewSection sectionId={sectionId} content={sec} accent={accent} />
        </div>
      ))}
    </div>
  )
}

function PreviewSection({ sectionId, content, accent }: { sectionId: string; content: ResumeContent; accent: string }) {
  const { t } = useExtensionI18n()
  const sec = content
  const title = (s: string) => (
    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase', color: accent, borderBottom: `1.5px solid ${accent}40`, paddingBottom: 3, marginBottom: 6 }}>{t(s)}</div>
  )

  switch (sectionId) {
    case 'summary':
      if (!sec.summary) return null
      return <div>{title('Summary')}<div style={{ fontSize: 10, color: '#555', lineHeight: 1.55 }}>{sec.summary}</div></div>

    case 'experience':
      if (!Array.isArray(sec.experience) || sec.experience.length === 0) return null
      return (
        <div>
          {title('Experience')}
          {sec.experience.map((exp, i) => (
            <div key={i} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: '#1a1a1a' }}>{exp.role || t('Role')}</span>
                <span style={{ fontSize: 9, color: '#888', flexShrink: 0, marginLeft: 8 }}>{exp.period}</span>
              </div>
              {exp.company && <div style={{ fontSize: 10, color: '#666', marginTop: 1 }}>{exp.company}</div>}
              {(exp.bullets ?? []).filter(Boolean).length > 0 && (
                <ul style={{ margin: '3px 0 0 12px', padding: 0 }}>
                  {(exp.bullets ?? []).filter(Boolean).map((b, j) => (
                    <li key={j} style={{ fontSize: 10, color: '#555', lineHeight: 1.45, marginBottom: 1 }}>{b}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )

    case 'skills':
      if (!Array.isArray(sec.skills) || sec.skills.length === 0) return null
      return (
        <div>
          {title('Skills')}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {sec.skills.map((sk, i) => (
              <span key={i} style={{ fontSize: 9, padding: '2px 7px', borderRadius: 3, background: '#f1f5f9', color: '#334155' }}>{sk}</span>
            ))}
          </div>
        </div>
      )

    case 'education':
      if (!Array.isArray(sec.education) || sec.education.length === 0) return null
      return (
        <div>
          {title('Education')}
          {sec.education.map((edu, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 2 }}>
              <span><span style={{ fontWeight: 600, color: '#1a1a1a' }}>{edu.institution || t('School')}</span>{edu.degree ? <span style={{ color: '#666' }}> — {edu.degree}</span> : null}</span>
              <span style={{ color: '#888' }}>{edu.year}</span>
            </div>
          ))}
        </div>
      )

    case 'languages':
      if (!sec.languages?.length) return null
      return (
        <div>
          {title('Languages')}
          <div style={{ display: 'flex', gap: 12 }}>
            {sec.languages.map((l, i) => (
              <span key={i} style={{ fontSize: 10, color: '#444' }}>{l.lang} <span style={{ color: '#888' }}>({l.level})</span></span>
            ))}
          </div>
        </div>
      )

    case 'projects':
      if (!sec.projects?.length) return null
      return (
        <div>
          {title('Projects')}
          {sec.projects.map((p, i) => (
            <div key={i} style={{ marginBottom: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 10, fontWeight: 600, color: '#1a1a1a' }}>{p.name}</span>
                {p.period && <span style={{ fontSize: 9, color: '#888' }}>{p.period}</span>}
              </div>
              {p.url && <div style={{ fontSize: 9, color: accent }}>{p.url}</div>}
              {(p.bullets ?? []).filter(Boolean).length > 0 && (
                <ul style={{ margin: '2px 0 0 12px', padding: 0 }}>
                  {(p.bullets ?? []).filter(Boolean).map((b, j) => (
                    <li key={j} style={{ fontSize: 9, color: '#555', lineHeight: 1.45 }}>{b}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )

    case 'certifications':
      if (!sec.certifications?.length) return null
      return (
        <div>
          {title('Certifications')}
          {sec.certifications.map((cert, i) => (
            <div key={i} style={{ fontSize: 10, marginBottom: 2, display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontWeight: 500, color: '#1a1a1a' }}>{cert.name}</span>
              <span style={{ color: '#888' }}>{cert.issuer}{cert.date ? ` · ${cert.date}` : ''}</span>
            </div>
          ))}
        </div>
      )

    default:
      // Custom sections
      const cs = sec.custom?.find(c => c.id === sectionId)
      if (!cs) return null
      return (
        <div>
          {title(cs.title || 'Section')}
          {cs.items.map((item, j) => (
            <div key={j} style={{ marginBottom: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                {item.title && <span style={{ fontSize: 10, fontWeight: 600, color: '#1a1a1a' }}>{item.title}</span>}
                {item.period && <span style={{ fontSize: 9, color: '#888' }}>{item.period}</span>}
              </div>
              {item.subtitle && <div style={{ fontSize: 9, color: '#666' }}>{item.subtitle}</div>}
              {(item.bullets ?? []).filter(Boolean).length > 0 && (
                <ul style={{ margin: '2px 0 0 12px', padding: 0 }}>
                  {(item.bullets ?? []).filter(Boolean).map((b, k) => (
                    <li key={k} style={{ fontSize: 9, color: '#555', lineHeight: 1.45 }}>{b}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )
  }
}

// ── Quick Edit Panel ─────────────────────────────────────────────────────────────

function QuickEdit({ content, onChange, settings, presentSections, onAddSection, apiBase }: {
  content: ResumeContent
  onChange: (c: ResumeContent) => void
  settings: ExtensionSettings
  presentSections: string[]
  onAddSection: (id: string) => void
  apiBase: string
}) {
  const { t } = useExtensionI18n()
  const [expandedSec, setExpandedSec] = useState<string | null>('contact')

  // Detect which sections are NOT yet present
  const missingSections = ALL_SECTION_IDS.filter(id => !presentSections.includes(id))

  function toggle(s: string) { setExpandedSec(prev => prev === s ? null : s) }

  function updateContact(f: string, v: string) {
    onChange({ ...content, contact: { ...content.contact, [f]: v } })
  }
  function updateSummary(v: string) { onChange({ ...content, summary: v }) }

  return (
    <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* Contact */}
      <EditSection label={t('Contact')} expanded={expandedSec === 'contact'} onToggle={() => toggle('contact')}>
        <Field label="Name" value={content.contact.name} onChange={v => updateContact('name', v)} />
        <Field label="Email" value={content.contact.email} onChange={v => updateContact('email', v)} />
        <Field label="Phone" value={content.contact.phone ?? ''} onChange={v => updateContact('phone', v)} />
        <Field label="Location" value={content.contact.location} onChange={v => updateContact('location', v)} />
        <Field label="LinkedIn" value={content.contact.linkedin ?? ''} onChange={v => updateContact('linkedin', v)} />
        <Field label="GitHub" value={content.contact.github ?? ''} onChange={v => updateContact('github', v)} />
      </EditSection>

      {/* Summary */}
      <EditSection label={t('Summary')} expanded={expandedSec === 'summary'} onToggle={() => toggle('summary')}>
        <textarea value={content.summary} onChange={e => updateSummary(e.target.value)} placeholder={t('Professional summary...')} style={taStyle(C)} />
      </EditSection>

      {/* Experience */}
      <EditSection label={`Experience (${content.experience.length})`} expanded={expandedSec === 'experience'} onToggle={() => toggle('experience')}>
        {content.experience.map((exp, i) => (
          <div key={i} style={{ padding: '6px', borderRadius: 6, background: C.bg, border: `0.5px solid ${C.border}`, marginBottom: 6 }}>
            <div style={{ display: 'flex', gap: 4, marginBottom: 3 }}>
              <input value={exp.role} onChange={e => { const u = [...content.experience]; u[i] = { ...exp, role: e.target.value }; onChange({ ...content, experience: u }) }} placeholder={t('Role')} style={si(C)} />
              <input value={exp.company} onChange={e => { const u = [...content.experience]; u[i] = { ...exp, company: e.target.value }; onChange({ ...content, experience: u }) }} placeholder={t('Company')} style={si(C)} />
            </div>
            <input value={exp.period} onChange={e => { const u = [...content.experience]; u[i] = { ...exp, period: e.target.value }; onChange({ ...content, experience: u }) }} placeholder={t('Period')} style={{ ...si(C), width: 100, marginBottom: 3 }} />
            {exp.bullets.map((b, j) => (
              <div key={j} style={{ display: 'flex', gap: 3, alignItems: 'center', marginBottom: 2 }}>
                <span style={{ fontSize: 9, color: C.subtle }}>•</span>
                <input value={b} onChange={e => { const u = [...content.experience]; const bl = [...exp.bullets]; bl[j] = e.target.value; u[i] = { ...exp, bullets: bl }; onChange({ ...content, experience: u }) }} style={si(C)} />
                <button onClick={() => { const u = [...content.experience]; u[i] = { ...exp, bullets: exp.bullets.filter((_, k) => k !== j) }; onChange({ ...content, experience: u }) }} style={xbtn(C)}>×</button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 4 }}>
              <button onClick={() => { const u = [...content.experience]; u[i] = { ...exp, bullets: [...exp.bullets, ''] }; onChange({ ...content, experience: u }) }} style={minibtn(C)}>+ {t('Bullet')}</button>
              <button onClick={() => onChange({ ...content, experience: content.experience.filter((_, j) => j !== i) })} style={{ ...minibtn(C), color: C.red }}>{t('Remove')}</button>
            </div>
          </div>
        ))}
        <button onClick={() => onChange({ ...content, experience: [...content.experience, { company: '', role: '', period: '', bullets: [] }] })} style={addbtn(C)}>+ {t('Add Experience')}</button>
      </EditSection>

      {/* Education */}
      <EditSection label={`Education (${content.education.length})`} expanded={expandedSec === 'education'} onToggle={() => toggle('education')}>
        {content.education.map((edu, i) => (
          <div key={i} style={{ padding: '6px', borderRadius: 6, background: C.bg, border: `0.5px solid ${C.border}`, marginBottom: 4 }}>
            <div style={{ display: 'flex', gap: 4, marginBottom: 3 }}>
              <input value={edu.institution} onChange={e => { const u = [...content.education]; u[i] = { ...edu, institution: e.target.value }; onChange({ ...content, education: u }) }} placeholder={t('School')} style={si(C)} />
              <input value={edu.degree} onChange={e => { const u = [...content.education]; u[i] = { ...edu, degree: e.target.value }; onChange({ ...content, education: u }) }} placeholder={t('Degree')} style={si(C)} />
            </div>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input value={edu.year} onChange={e => { const u = [...content.education]; u[i] = { ...edu, year: e.target.value }; onChange({ ...content, education: u }) }} placeholder={t('Year')} style={{ ...si(C), width: 80 }} />
              <button onClick={() => onChange({ ...content, education: content.education.filter((_, j) => j !== i) })} style={{ ...minibtn(C), color: C.red, marginLeft: 'auto' }}>{t('Remove')}</button>
            </div>
          </div>
        ))}
        <button onClick={() => onChange({ ...content, education: [...content.education, { institution: '', degree: '', year: '' }] })} style={addbtn(C)}>+ {t('Add Education')}</button>
      </EditSection>

      {/* Skills */}
      <EditSection label={`Skills (${content.skills.length})`} expanded={expandedSec === 'skills'} onToggle={() => toggle('skills')}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginBottom: 6 }}>
          {content.skills.map((sk, i) => (
            <span key={i} style={{ fontSize: 9, padding: '2px 6px', borderRadius: 999, background: `${C.primary}10`, color: C.primary, display: 'flex', alignItems: 'center', gap: 4 }}>
              {sk}
              <button onClick={() => onChange({ ...content, skills: content.skills.filter((_, j) => j !== i) })} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.subtle, fontSize: 10, padding: 0, lineHeight: 1 }}>×</button>
            </span>
          ))}
        </div>
        <form onSubmit={e => { e.preventDefault(); const inp = (e.target as HTMLFormElement).querySelector('input'); if (!inp) return; const v = inp.value.trim(); if (!v || content.skills.includes(v)) return; onChange({ ...content, skills: [...content.skills, v] }); inp.value = '' }}>
          <input placeholder={t('Type skill + Enter...')} style={{ width: '100%', padding: '5px 8px', fontSize: 10, borderRadius: 6, border: `1px solid ${C.border}`, background: C.bg, color: C.text, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }} />
        </form>
      </EditSection>

      {/* Languages — if present */}
      {presentSections.includes('languages') && (
        <EditSection label={`Languages (${(content.languages ?? []).length})`} expanded={expandedSec === 'languages'} onToggle={() => toggle('languages')}>
          {(content.languages ?? []).map((l, i) => (
            <div key={i} style={{ display: 'flex', gap: 3, marginBottom: 3, alignItems: 'center' }}>
              <input value={l.lang} onChange={e => { const u = [...(content.languages ?? [])]; u[i] = { ...l, lang: e.target.value }; onChange({ ...content, languages: u }) }} placeholder={t('Language')} style={si(C)} />
              <input value={l.level} onChange={e => { const u = [...(content.languages ?? [])]; u[i] = { ...l, level: e.target.value }; onChange({ ...content, languages: u }) }} placeholder={t('Level')} style={{ ...si(C), width: 70 }} />
              <button onClick={() => onChange({ ...content, languages: (content.languages ?? []).filter((_, j) => j !== i) })} style={xbtn(C)}>×</button>
            </div>
          ))}
          <button onClick={() => onChange({ ...content, languages: [...(content.languages ?? []), { lang: '', level: '' }] })} style={addbtn(C)}>+ {t('Add Language')}</button>
        </EditSection>
      )}

      {/* Projects — if present */}
      {presentSections.includes('projects') && (
        <EditSection label={`Projects (${(content.projects ?? []).length})`} expanded={expandedSec === 'projects'} onToggle={() => toggle('projects')}>
          {(content.projects ?? []).map((p, i) => (
            <div key={i} style={{ padding: '6px', borderRadius: 6, background: C.bg, border: `0.5px solid ${C.border}`, marginBottom: 4 }}>
              <input value={p.name} onChange={e => { const u = [...(content.projects ?? [])]; u[i] = { ...p, name: e.target.value }; onChange({ ...content, projects: u }) }} placeholder={t('Project name')} style={{ ...si(C), width: '100%', marginBottom: 3 }} />
              <input value={p.url ?? ''} onChange={e => { const u = [...(content.projects ?? [])]; u[i] = { ...p, url: e.target.value }; onChange({ ...content, projects: u }) }} placeholder={t('URL')} style={{ ...si(C), width: '100%', marginBottom: 3 }} />
              <div style={{ display: 'flex', gap: 4 }}>
                <button onClick={() => onChange({ ...content, projects: (content.projects ?? []).filter((_, j) => j !== i) })} style={{ ...minibtn(C), color: C.red }}>{t('Remove')}</button>
              </div>
            </div>
          ))}
          <button onClick={() => onChange({ ...content, projects: [...(content.projects ?? []), { name: '', bullets: [] }] })} style={addbtn(C)}>+ {t('Add Project')}</button>
        </EditSection>
      )}

      {/* Certifications — if present */}
      {presentSections.includes('certifications') && (
        <EditSection label={`Certifications (${(content.certifications ?? []).length})`} expanded={expandedSec === 'certifications'} onToggle={() => toggle('certifications')}>
          {(content.certifications ?? []).map((c, i) => (
            <div key={i} style={{ padding: '6px', borderRadius: 6, background: C.bg, border: `0.5px solid ${C.border}`, marginBottom: 4 }}>
              <input value={c.name} onChange={e => { const u = [...(content.certifications ?? [])]; u[i] = { ...c, name: e.target.value }; onChange({ ...content, certifications: u }) }} placeholder={t('Name')} style={{ ...si(C), width: '100%', marginBottom: 3 }} />
              <input value={c.issuer} onChange={e => { const u = [...(content.certifications ?? [])]; u[i] = { ...c, issuer: e.target.value }; onChange({ ...content, certifications: u }) }} placeholder={t('Issuer')} style={{ ...si(C), width: '100%', marginBottom: 3 }} />
              <div style={{ display: 'flex', gap: 4 }}>
                <button onClick={() => onChange({ ...content, certifications: (content.certifications ?? []).filter((_, j) => j !== i) })} style={{ ...minibtn(C), color: C.red }}>{t('Remove')}</button>
              </div>
            </div>
          ))}
          <button onClick={() => onChange({ ...content, certifications: [...(content.certifications ?? []), { name: '', issuer: '', date: '' }] })} style={addbtn(C)}>+ {t('Add Certification')}</button>
        </EditSection>
      )}

      {/* Custom Sections */}
      {(content.custom ?? []).map((cs, i) => (
        <EditSection key={cs.id} label={cs.title || `Custom ${i + 1}`} expanded={expandedSec === `custom:${cs.id}`} onToggle={() => toggle(`custom:${cs.id}`)}>
          <div style={{ padding: '6px', borderRadius: 6, background: C.bg, border: `0.5px solid ${C.border}`, marginBottom: 6 }}>
            <input value={cs.title} onChange={e => {
              const u = [...(content.custom ?? [])]; u[i] = { ...cs, title: e.target.value }; onChange({ ...content, custom: u })
            }} placeholder={t('Section title')} style={{ ...si(C), width: '100%', marginBottom: 4 }} />
            {cs.items.map((item, j) => (
              <div key={j} style={{ padding: '4px', borderRadius: 4, background: C.card, border: `0.5px solid ${C.border}`, marginBottom: 4 }}>
                <div style={{ display: 'flex', gap: 3, marginBottom: 2 }}>
                  <input value={item.title ?? ''} onChange={e => {
                    const u = [...(content.custom ?? [])]; u[i] = { ...cs, items: cs.items.map((it, k) => k === j ? { ...it, title: e.target.value } : it) }; onChange({ ...content, custom: u })
                  }} placeholder={t('Item title')} style={si(C)} />
                  <input value={item.subtitle ?? ''} onChange={e => {
                    const u = [...(content.custom ?? [])]; u[i] = { ...cs, items: cs.items.map((it, k) => k === j ? { ...it, subtitle: e.target.value } : it) }; onChange({ ...content, custom: u })
                  }} placeholder={t('Subtitle')} style={si(C)} />
                </div>
                <input value={item.period ?? ''} onChange={e => {
                  const u = [...(content.custom ?? [])]; u[i] = { ...cs, items: cs.items.map((it, k) => k === j ? { ...it, period: e.target.value } : it) }; onChange({ ...content, custom: u })
                }} placeholder={t('Period')} style={{ ...si(C), width: 80, marginBottom: 2 }} />
                {item.bullets.map((b, k) => (
                  <div key={k} style={{ display: 'flex', gap: 3, alignItems: 'center', marginBottom: 1 }}>
                    <span style={{ fontSize: 9, color: C.subtle }}>•</span>
                    <input value={b} onChange={e => {
                      const u = [...(content.custom ?? [])]; u[i] = { ...cs, items: cs.items.map((it, idx) => idx === j ? { ...it, bullets: it.bullets.map((bl, bk) => bk === k ? e.target.value : bl) } : it) }; onChange({ ...content, custom: u })
                    }} style={si(C)} />
                    <button onClick={() => {
                      const u = [...(content.custom ?? [])]; u[i] = { ...cs, items: cs.items.map((it, idx) => idx === j ? { ...it, bullets: it.bullets.filter((_, bk) => bk !== k) } : it) }; onChange({ ...content, custom: u })
                    }} style={xbtn(C)}>×</button>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 4 }}>
                  <button onClick={() => {
                    const u = [...(content.custom ?? [])]; u[i] = { ...cs, items: cs.items.map((it, idx) => idx === j ? { ...it, bullets: [...it.bullets, ''] } : it) }; onChange({ ...content, custom: u })
                  }} style={minibtn(C)}>+ {t('Bullet')}</button>
                  <button onClick={() => {
                    const u = [...(content.custom ?? [])]; u[i] = { ...cs, items: cs.items.filter((_, idx) => idx !== j) }; onChange({ ...content, custom: u })
                  }} style={{ ...minibtn(C), color: C.red }}>{t('Remove Item')}</button>
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 4 }}>
              <button onClick={() => {
                const u = [...(content.custom ?? [])]; u[i] = { ...cs, items: [...cs.items, { bullets: [] }] }; onChange({ ...content, custom: u })
              }} style={minibtn(C)}>+ {t('Item')}</button>
              <button onClick={() => onChange({ ...content, custom: (content.custom ?? []).filter((_, idx) => idx !== i) })} style={{ ...minibtn(C), color: C.red }}>{t('Delete Section')}</button>
            </div>
          </div>
        </EditSection>
      ))}

      {/* ── Add Section — show missing sections + custom ── */}
      {(missingSections.length > 0 || true) && (
        <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 8, marginTop: 4 }}>
          <div style={{ fontSize: 9, fontWeight: 600, color: C.subtle, marginBottom: 6, textTransform: 'uppercase' }}>{t('Add Section')}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {missingSections.map(id => (
              <button key={id} onClick={() => onAddSection(id)} style={{ fontSize: 9, padding: '4px 10px', borderRadius: 999, background: 'transparent', color: C.primary, border: `1px solid ${C.primary}30`, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
              + {t(id.charAt(0).toUpperCase() + id.slice(1))}
              </button>
            ))}
            <button key="custom" onClick={() => onAddSection('custom')} style={{ fontSize: 9, padding: '4px 10px', borderRadius: 999, background: 'transparent', color: C.teal, border: `1px solid ${C.teal}30`, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
              + {t('Custom Section')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tiny Components ──────────────────────────────────────────────────────────────

function EditSection({ label, expanded, onToggle, children }: { label: string; expanded: boolean; onToggle: () => void; children: React.ReactNode }) {
  const { t } = useExtensionI18n()
  const translatedLabel = label.replace(/^(Experience|Education|Skills|Languages|Projects|Certifications)/, value => t(value))
  return (
    <div>
      <button onClick={onToggle} style={{ width: '100%', padding: '6px 0', display: 'flex', justifyContent: 'space-between', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 10, fontWeight: 600, color: C.text, borderBottom: expanded ? `1px solid ${C.border}` : 'none' }}>
        {translatedLabel}<span style={{ fontSize: 9, color: C.subtle }}>{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && <div style={{ padding: '6px 0' }}>{children}</div>}
    </div>
  )
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const { t } = useExtensionI18n()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
      <span style={{ fontSize: 9, color: C.muted, width: 50, flexShrink: 0 }}>{t(label)}</span>
      <input value={value} onChange={e => onChange(e.target.value)} style={{ flex: 1, padding: '4px 6px', fontSize: 10, borderRadius: 4, border: `0.5px solid ${C.border}`, background: C.bg, color: C.text, fontFamily: 'inherit', outline: 'none' }} />
    </div>
  )
}

// ── Template Thumbnail — mini visual preview of each template ────────────────────

function TemplateThumbnail({ id, accent, font }: { id: string; accent: string; font: string }) {
  const h = 64, w = '100%'
  const muted = '#cbd5e1', dark = '#64748b'
  const bar = (y: number, w2: string, c = muted) => <rect x={10} y={y} width={w2} height={2} rx={1} fill={c} key={y} />

  switch (id) {
    case 'clean':
      return (
        <svg viewBox="0 0 90 64" style={{ display: 'block', width: w, height: h, background: '#fff', fontFamily: font }}>
          <rect x={10} y={6} width={40} height={3} rx={1.5} fill={dark} />
          <line x1={10} y1={12} x2={55} y2={12} stroke={accent} strokeWidth={1.5} />
          {bar(18, '30', accent)}{bar(22, '55', muted)}{bar(27, '48', muted)}{bar(32, '55', muted)}{bar(37, '45', muted)}
          <rect x={10} y={44} width={70} height={1} rx={0.5} fill={accent} opacity={0.4} />
          {bar(48, '50', accent)}{bar(52, '62', muted)}{bar(56, '55', muted)}
        </svg>
      )
    case 'executive':
      return (
        <svg viewBox="0 0 90 64" style={{ display: 'block', width: w, height: h, background: '#fff', fontFamily: font }}>
          <rect x={0} y={0} width={90} height={22} fill={accent} />
          <rect x={10} y={6} width={40} height={3} rx={1.5} fill="#fff" opacity={0.95} />
          <line x1={10} y1={12} x2={50} y2={12} stroke="#fff" strokeWidth={1} opacity={0.6} />
          <rect x={0} y={22} width={90} height={42} fill="#fff" />
          {bar(28, '55', muted)}{bar(33, '48', muted)}{bar(38, '60', muted)}{bar(42, '45', muted)}
          <rect x={10} y={50} width={70} height={1} rx={0.5} fill={accent} opacity={0.5} />
          {bar(54, '50', muted)}{bar(58, '58', muted)}
        </svg>
      )
    case 'sidebar':
      return (
        <svg viewBox="0 0 90 64" style={{ display: 'block', width: w, height: h, background: '#fff', fontFamily: font }}>
          <rect x={0} y={0} width={25} height={64} fill={accent} opacity={0.12} />
          <rect x={4} y={6} width={17} height={3} rx={1.5} fill={accent} />
          <rect x={4} y={12} width={14} height={2} rx={1} fill={accent} opacity={0.7} />
          <rect x={4} y={16} width={16} height={2} rx={1} fill={accent} opacity={0.5} />
          <rect x={4} y={20} width={12} height={2} rx={1} fill={accent} opacity={0.6} />
          <rect x={29} y={6} width={50} height={3} rx={1.5} fill={dark} />
          <line x1={29} y1={12} x2={80} y2={12} stroke={accent} strokeWidth={1} />
          <rect x={29} y={17} width={45} height={2} rx={1} fill={accent} opacity={0.5} />
          <rect x={29} y={22} width={52} height={2} rx={1} fill={muted} />
          <rect x={29} y={27} width={48} height={2} rx={1} fill={muted} />
          <rect x={29} y={34} width={50} height={2} rx={1} fill={accent} opacity={0.5} />
          <rect x={29} y={39} width={55} height={2} rx={1} fill={muted} />
          <rect x={29} y={44} width={42} height={2} rx={1} fill={muted} />
        </svg>
      )
    case 'timeline':
      return (
        <svg viewBox="0 0 90 64" style={{ display: 'block', width: w, height: h, background: '#fff', fontFamily: font }}>
          <rect x={10} y={6} width={40} height={3} rx={1.5} fill={dark} />
          <line x1={10} y1={12} x2={55} y2={12} stroke={accent} strokeWidth={1.5} />
          <rect x={10} y={18} width={2} height={40} rx={1} fill={accent} opacity={0.3} />
          <circle cx={11} cy={24} r={2.5} fill={accent} />
          <rect x={18} y={22} width={35} height={2} rx={1} fill={dark} />
          <rect x={18} y={26} width={55} height={1.5} rx={0.75} fill={muted} />
          <circle cx={11} cy={36} r={2.5} fill={accent} />
          <rect x={18} y={34} width={30} height={2} rx={1} fill={dark} />
          <rect x={18} y={38} width={48} height={1.5} rx={0.75} fill={muted} />
          <circle cx={11} cy={48} r={2.5} fill={accent} />
          <rect x={18} y={46} width={38} height={2} rx={1} fill={dark} />
          <rect x={18} y={50} width={52} height={1.5} rx={0.75} fill={muted} />
        </svg>
      )
    case 'compact':
      return (
        <svg viewBox="0 0 90 64" style={{ display: 'block', width: w, height: h, background: '#fff', fontFamily: font }}>
          <rect x={4} y={4} width={40} height={2.5} rx={1.25} fill={dark} />
          <line x1={4} y1={9} x2={48} y2={9} stroke={accent} strokeWidth={1.5} />
          <rect x={4} y={14} width={82} height={1} rx={0.5} fill={accent} opacity={0.4} />
          {bar(19, '55', muted)}{bar(23, '48', muted)}{bar(27, '60', muted)}
          <rect x={4} y={32} width={82} height={1} rx={0.5} fill={accent} opacity={0.4} />
          {bar(37, '50', muted)}{bar(41, '55', muted)}{bar(45, '42', muted)}
          <rect x={4} y={50} width={82} height={1} rx={0.5} fill={accent} opacity={0.4} />
          {bar(55, '62', muted)}{bar(59, '55', muted)}
        </svg>
      )
    default:
      return <div style={{ height: h, background: '#fff' }} />
  }
}

function Spinner() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
      <div style={{ width: 22, height: 22, border: '2.5px solid rgba(79,70,229,0.15)', borderTopColor: C.primary, borderRadius: '50%', animation: 'rv-spin 0.7s linear infinite' }} />
      <style>{'@keyframes rv-spin{to{transform:rotate(360deg)}}'}</style>
    </div>
  )
}

// ── Style helpers ────────────────────────────────────────────────────────────────

function si(C: Record<string, string>): React.CSSProperties {
  return { flex: 1, padding: '3px 5px', fontSize: 9, border: `0.5px solid ${C.border}`, borderRadius: 3, background: C.card, color: C.text, fontFamily: 'inherit', outline: 'none', minWidth: 0, boxSizing: 'border-box' as const }
}
function xbtn(C: Record<string, string>): React.CSSProperties {
  return { background: 'none', border: 'none', color: C.subtle, cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1 }
}
function minibtn(C: Record<string, string>): React.CSSProperties {
  return { fontSize: 8, padding: '2px 8px', borderRadius: 999, background: 'transparent', color: C.primary, border: `0.5px solid ${C.primary}30`, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }
}
function addbtn(C: Record<string, string>): React.CSSProperties {
  return { padding: '5px', borderRadius: 6, background: C.primary, color: '#fff', border: 'none', fontSize: 9, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', width: '100%' }
}
function selectStyle(C: Record<string, string>): React.CSSProperties {
  return { flex: 1, padding: '6px 8px', fontSize: 11, minWidth: 0, border: `1px solid ${C.border}`, borderRadius: 7, background: C.bg, color: C.text, fontFamily: 'inherit', outline: 'none', cursor: 'pointer' }
}
function iconBtn(C: Record<string, string>): React.CSSProperties {
  return { width: 30, height: 30, borderRadius: 7, flexShrink: 0, border: 'none', fontSize: 16, cursor: 'pointer', lineHeight: 1, fontWeight: 700, fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center' }
}
function btnPrimary(C: Record<string, string>): React.CSSProperties {
  return { padding: '10px 28px', background: C.primary, color: '#fff', border: 'none', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }
}
function btnGhost(C: Record<string, string>): React.CSSProperties {
  return { padding: '10px 28px', background: C.bg, color: C.muted, border: `1px solid ${C.border}`, borderRadius: 10, fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }
}
function taStyle(C: Record<string, string>): React.CSSProperties {
  return { width: '100%', height: 70, padding: '6px 8px', resize: 'vertical', fontSize: 10, border: `1px solid ${C.border}`, borderRadius: 6, fontFamily: 'inherit', color: C.text, outline: 'none', background: C.bg, boxSizing: 'border-box' }
}
