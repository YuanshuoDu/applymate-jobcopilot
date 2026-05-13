/**
 * ResumeView — Simplified resume tab for the sidebar.
 *
 * Layout (top to bottom):
 *   1. Top bar: resume selector + new + upload
 *   2. Job Match: AI scoring + suggestions with one-click apply (if job detected)
 *   3. Preview: rendered with template styling — the final look
 *   4. Template picker: style / accent color / density
 *   5. Quick Edit: collapsed by default, can add/remove sections
 *   6. Download PDF button
 *
 * Syncs bidirectionally with the web app via the REST API.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { getCurrentResumeId, setCurrentResumeId, setResumeDraft, clearResumeDraft } from '@/lib/storage'
import {
  listResumes, getResume, updateResume, createResume,
  scoreResume, suggestResume,
} from '@/lib/api'
import type { ExtensionSettings, ScrapedJob, ResumeListItem, Resume, ResumeContent, TemplateOptions, ScoreResult, Suggestion } from '@/lib/types'

// ── Design tokens ────────────────────────────────────────────────────────────────
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

const EMPTY_CONTENT: ResumeContent = {
  contact: { name: '', email: '', location: '' },
  summary: '',
  experience: [],
  education: [],
  skills: [],
}

const TEMPLATE_NAMES: Record<string, string> = {
  clean: 'Clean', executive: 'Executive', sidebar: 'Sidebar',
  timeline: 'Timeline', compact: 'Compact',
}

const ACCENT_COLORS = [
  { v: '#185FA5', n: 'Blue' }, { v: '#475569', n: 'Slate' },
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

// ── Root ─────────────────────────────────────────────────────────────────────────
export function ResumeView({ settings }: Props) {
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
  const [scoreResult, setScoreResult] = useState<ScoreResult | null>(null)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [analyzing, setAnalyzing] = useState(false)
  const [uploading, setUploading] = useState(false)

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const apiBase = settings.apiBaseUrl

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(''), 2500) }

  // ── Init ───────────────────────────────────────────────────────────────────────
  useEffect(() => {
    loadResumeList()
    chrome.storage.local.get('currentJob', r => { if (r.currentJob) setCurrentJob(r.currentJob) })
    const handler = (msg: any) => { if (msg.type === 'JOB_SCRAPED' && msg.job) setCurrentJob(msg.job) }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [])

  async function loadResumeList() {
    try {
      const list = await listResumes(settings)
      setResumes(list)
      if (list.length > 0) {
        const savedId = await getCurrentResumeId()
        const targetId = savedId && list.find(r => r.id === savedId) ? savedId : list[0].id
        setActiveId(targetId)
        await loadResume(targetId)
      } else { setLoading(false) }
    } catch { setLoading(false) }
  }

  async function loadResume(id: string) {
    setLoading(true)
    try {
      const r = await getResume(settings, id)
      setResume(r)
      setContent(r.content ?? EMPTY_CONTENT)
      setTemplateId(r.templateId ?? 'clean')
      setTemplateOpts(r.templateOptions ?? {})
      setDirty(false)
      setScoreResult(null)
      setSuggestions([])
      await setCurrentResumeId(id)
    } catch { showToast('Failed to load') }
    finally { setLoading(false) }
  }

  async function handleSelect(id: string) { setActiveId(id); await loadResume(id) }
  async function handleCreate() {
    try {
      const r = await createResume(settings, { name: `Resume ${resumes.length + 1}`, content: EMPTY_CONTENT, templateId: 'clean' })
      setResumes(prev => [r, ...prev]); setActiveId(r.id); setResume(r)
      setContent(EMPTY_CONTENT); setTemplateId('clean'); setTemplateOpts({}); setDirty(false)
      await setCurrentResumeId(r.id); showToast('Created')
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
      setContent(r.content); setTemplateId('clean'); setTemplateOpts({}); setDirty(false)
      await setCurrentResumeId(r.id); showToast('Resume uploaded & parsed!')
    } catch { showToast('Upload failed') }
    finally { setUploading(false) }
  }

  // ── Save ───────────────────────────────────────────────────────────────────────
  const doSave = useCallback(async (c: ResumeContent, tid: string | null, topts: TemplateOptions) => {
    if (!activeId) return
    setSaving(true)
    try {
      await updateResume(settings, activeId, { content: c, templateId: tid, templateOptions: topts })
      setDirty(false); clearResumeDraft(activeId)
    } catch { showToast('Save failed'); setResumeDraft(activeId, c) }
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

  // ── AI Analysis ────────────────────────────────────────────────────────────────
  async function handleAnalyze() {
    if (!currentJob) return
    setAnalyzing(true); setScoreResult(null); setSuggestions([])
    try {
      const [score, suggs] = await Promise.all([
        scoreResume(settings, { resumeContent: content, jobTitle: currentJob.title, jobCompany: currentJob.company, jobDescription: currentJob.description }),
        suggestResume(settings, { resumeContent: content, jobTitle: currentJob.title, jobCompany: currentJob.company, jobDescription: currentJob.description }),
      ])
      setScoreResult(score); setSuggestions(suggs.suggestions ?? [])
    } catch { showToast('Analysis failed') }
    finally { setAnalyzing(false) }
  }

  function applySuggestion(s: Suggestion) {
    if (!s.proposed) return
    const updated = { ...content }
    switch (s.target) {
      case 'summary': updated.summary = s.proposed; break
      case 'skills': updated.skills = s.proposed.split(',').map(x => x.trim()).filter(Boolean); break
      case 'experience':
        if (updated.experience.length > 0) {
          updated.experience = updated.experience.map((exp, i) => i === 0 ? { ...exp, bullets: [...exp.bullets, s.proposed!] } : exp)
        } else { updated.experience = [{ company: '', role: '', period: '', bullets: [s.proposed!] }] }
        break
      case 'education':
        updated.education = [...(updated.education ?? []), { institution: s.proposed, degree: '', year: '' }]; break
    }
    markDirty(updated)
    setSuggestions(prev => prev.map(sg => sg === s ? { ...sg, applied: true } : sg))
    showToast('Applied!')
  }

  function addMissingKeyword(item: { keyword: string; target: string }) {
    const updated = { ...content }
    if (item.target === 'skills' && !updated.skills.includes(item.keyword)) updated.skills = [...updated.skills, item.keyword]
    else if (item.target === 'summary') updated.summary = updated.summary ? `${updated.summary} ${item.keyword}` : item.keyword
    markDirty(updated); showToast(`Added: ${item.keyword}`)
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

  // ── Resolved template options ──────────────────────────────────────────────────
  const accent = templateOpts.accentColor ?? ACCENT_COLORS[0].v
  const font = FONT_MAP[templateOpts.fontFamily ?? 'sans']
  const density = templateOpts.density ?? 'comfortable'

  // ── Loading ────────────────────────────────────────────────────────────────────
  if (loading && !resume) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}><Spinner /></div>
  }

  // ── Empty state ────────────────────────────────────────────────────────────────
  if (!loading && resumes.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: 16, padding: 28, textAlign: 'center', background: C.bg, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
        <div style={{ fontSize: 40 }}>📄</div>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>No resumes yet</div>
        <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.6 }}>Create one or upload a PDF/DOCX</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handleCreate} style={btnPrimary(C)}>+ Create Resume</button>
          <button onClick={() => fileInputRef.current?.click()} style={btnGhost(C)} disabled={uploading}>
            {uploading ? 'Uploading...' : 'Upload PDF/DOCX'}
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: C.bg, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      {/* ════ Top Bar: Selector + New + Upload ════ */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '10px 12px', display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
        <select value={activeId ?? ''} onChange={e => handleSelect(e.target.value)} style={selectStyle(C)}>
          {resumes.map(r => (<option key={r.id} value={r.id}>{r.name}{r.isDefault ? ' ★' : ''}</option>))}
        </select>
        <button onClick={handleCreate} title="New resume" style={{ ...iconBtn(C), background: C.primary, color: '#fff' }}>+</button>
        <button onClick={() => fileInputRef.current?.click()} title="Upload PDF/DOCX" style={{ ...iconBtn(C), background: C.bg, border: `1px solid ${C.border}`, color: C.muted, fontSize: 10, fontWeight: 500, width: 'auto', padding: '0 8px', whiteSpace: 'nowrap' }}>
          {uploading ? '...' : 'Upload'}
        </button>
        <input ref={fileInputRef} type="file" accept=".pdf,.docx,.doc" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); e.target.value = '' }} />
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '10px' }}>
        {/* ══════════════════════════════════════════════════════════════════════════
            1️⃣  JOB MATCH
           ═══════════════════════════════════════════════════════════════════════ */}
        {currentJob && (
          <div style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, padding: '12px', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <div style={{ width: 28, height: 28, borderRadius: 7, flexShrink: 0, background: `${C.primary}12`, color: C.primary, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700 }}>
                {currentJob.company.slice(0, 2).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentJob.title}</div>
                <div style={{ fontSize: 10, color: C.muted }}>{currentJob.company}{currentJob.location ? ` · ${currentJob.location}` : ''}</div>
              </div>
            </div>
            <button onClick={handleAnalyze} disabled={analyzing} style={{ width: '100%', padding: '8px', borderRadius: 7, border: 'none', background: analyzing ? `${C.primary}80` : C.primary, color: '#fff', fontSize: 11, fontWeight: 600, cursor: analyzing ? 'default' : 'pointer', fontFamily: 'inherit' }}>
              {analyzing ? 'Analyzing...' : scoreResult ? 'Re-analyze Match' : 'Analyze Match'}
            </button>

            {scoreResult && (
              <div style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 48, height: 48, borderRadius: '50%', background: `conic-gradient(${scoreResult.score >= 80 ? C.green : scoreResult.score >= 50 ? C.primary : C.amber} ${scoreResult.score}%, ${C.border} ${scoreResult.score}%)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <div style={{ width: 36, height: 36, borderRadius: '50%', background: C.card, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: scoreResult.score >= 80 ? C.green : scoreResult.score >= 50 ? C.primary : C.amber }}>{scoreResult.score}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: C.text }}>{scoreResult.score >= 80 ? 'Strong Match' : scoreResult.score >= 50 ? 'Good Match' : 'Needs Work'}</div>
                    {scoreResult.strengthSummary && <div style={{ fontSize: 9, color: C.muted, marginTop: 2 }}>{scoreResult.strengthSummary}</div>}
                  </div>
                </div>
                {scoreResult.matchedKeywords.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 9, fontWeight: 600, color: C.subtle, marginBottom: 4, textTransform: 'uppercase' }}>Matched</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                      {scoreResult.matchedKeywords.slice(0, 12).map(kw => (
                        <span key={kw} style={{ fontSize: 9, padding: '2px 6px', borderRadius: 999, background: 'rgba(59,109,17,0.1)', color: C.green, border: '0.5px solid rgba(59,109,17,0.2)' }}>{kw}</span>
                      ))}
                    </div>
                  </div>
                )}
                {scoreResult.missingItems.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 9, fontWeight: 600, color: C.subtle, marginBottom: 4, textTransform: 'uppercase' }}>Missing</div>
                    {scoreResult.missingItems.slice(0, 6).map(item => (
                      <div key={item.keyword} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '3px 0', borderBottom: `0.5px solid ${C.border}20` }}>
                        <div><span style={{ fontSize: 10, color: C.red }}>{item.keyword}</span><span style={{ fontSize: 8, color: C.subtle, marginLeft: 6 }}>{item.target}</span></div>
                        <button onClick={() => addMissingKeyword(item)} style={{ fontSize: 9, padding: '2px 8px', borderRadius: 999, background: C.primary, color: '#fff', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>+ Add</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {suggestions.filter(s => !s.applied).length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 9, fontWeight: 600, color: C.subtle, marginBottom: 6, textTransform: 'uppercase' }}>AI Suggestions · One-Click Apply</div>
                {suggestions.filter(s => !s.applied).map((s, i) => (
                  <div key={i} style={{ padding: '8px 10px', borderRadius: 8, marginBottom: 6, background: C.bg, border: `0.5px solid ${C.border}` }}>
                    <div style={{ fontSize: 10, color: C.text, marginBottom: 4, lineHeight: 1.4 }}>{s.text}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 999, background: 'rgba(24,95,165,0.08)', color: C.primary }}>{s.target}</span>
                      <span style={{ fontSize: 9, color: C.subtle }}>{s.action}</span>
                      <button onClick={() => applySuggestion(s)} style={{ fontSize: 9, padding: '3px 12px', borderRadius: 999, background: C.green, color: '#fff', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, marginLeft: 'auto' }}>Apply</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════════════
            2️⃣  RESUME PREVIEW — template applied, ready-to-go look
           ═══════════════════════════════════════════════════════════════════════ */}
        <div style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, marginBottom: 10, overflow: 'hidden' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', borderBottom: `1px solid ${C.border}` }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: C.text }}>📋 Preview</span>
            <button onClick={() => setEditMode(v => !v)} style={{ fontSize: 9, fontWeight: 600, padding: '3px 10px', borderRadius: 999, background: editMode ? C.primary : C.bg, color: editMode ? '#fff' : C.muted, border: `0.5px solid ${editMode ? C.primary : C.border}`, cursor: 'pointer', fontFamily: 'inherit' }}>
              {editMode ? 'Done' : '✎ Quick Edit'}
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
        <div style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, padding: '12px', marginBottom: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: C.text, marginBottom: 8 }}>🎨 Template</div>

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
              <option value="sans">Sans</option>
              <option value="serif">Serif</option>
              <option value="mono">Mono</option>
            </select>
          </div>

          {/* Density */}
          <select value={density} onChange={e => changeDensity(e.target.value as TemplateOptions['density'])} style={{ width: '100%', padding: '5px 8px', fontSize: 10, borderRadius: 6, border: `1px solid ${C.border}`, background: C.bg, color: C.text, fontFamily: 'inherit', outline: 'none', cursor: 'pointer' }}>
            <option value="compact">Compact</option>
            <option value="comfortable">Comfortable</option>
            <option value="spacious">Spacious</option>
          </select>
        </div>

        {/* ══════════════════════════════════════════════════════════════════════════
            4️⃣  DOWNLOAD PDF (the only download entry)
           ═══════════════════════════════════════════════════════════════════════ */}
        <div style={{ background: `linear-gradient(135deg, ${C.green}06, ${C.green}02)`, borderRadius: 10, border: `1.5px solid ${C.green}20`, padding: '14px', marginBottom: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: C.text, marginBottom: 2 }}>Download PDF</div>
          <div style={{ fontSize: 9, color: C.muted, marginBottom: 10 }}>Opens print view → save as PDF → drag to upload portal</div>
          <button onClick={handleOpenPrint} disabled={!activeId} style={{ width: '100%', padding: '10px', borderRadius: 8, background: activeId ? C.green : `${C.green}60`, color: '#fff', border: 'none', fontSize: 12, fontWeight: 600, cursor: activeId ? 'pointer' : 'default', fontFamily: 'inherit' }}>
            Print & Download PDF →
          </button>
        </div>

        {/* ── Sync status ── */}
        <div style={{ padding: '6px 0', display: 'flex', alignItems: 'center', gap: 8, fontSize: 9, color: C.subtle }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: dirty ? C.amber : saving ? C.subtle : C.green, display: 'inline-block' }} />
          {saving ? 'Saving...' : dirty ? 'Unsaved' : 'Synced'}
          <button onClick={() => activeId && loadResume(activeId)} style={{ background: 'none', border: `0.5px solid ${C.border}`, borderRadius: 4, padding: '1px 6px', fontSize: 8, cursor: 'pointer', color: C.muted, fontFamily: 'inherit', marginLeft: 'auto' }}>↺ Refresh</button>
        </div>
      </div>

      {/* ── Toast ── */}
      {toast && (
        <div style={{ position: 'fixed', bottom: 60, left: '50%', transform: 'translateX(-50%)', background: '#0f172a', color: '#fff', padding: '8px 18px', borderRadius: 20, fontSize: 11, zIndex: 9999, whiteSpace: 'nowrap', boxShadow: '0 4px 16px rgba(0,0,0,0.2)', fontWeight: 600 }}>{toast}</div>
      )}
    </div>
  )
}

// ── Template Preview — renders resume with template styling ──────────────────────

function TemplatePreview({ content, accent, font, density, presentSections, customIds }: {
  content: ResumeContent; accent: string; font: string; density: string
  presentSections: string[]; customIds: string[]
}) {
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
  const sec = content
  const title = (s: string) => (
    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase', color: accent, borderBottom: `1.5px solid ${accent}40`, paddingBottom: 3, marginBottom: 6 }}>{s}</div>
  )

  switch (sectionId) {
    case 'summary':
      if (!sec.summary) return null
      return <div>{title('Summary')}<div style={{ fontSize: 10, color: '#555', lineHeight: 1.55 }}>{sec.summary}</div></div>

    case 'experience':
      if (sec.experience.length === 0) return null
      return (
        <div>
          {title('Experience')}
          {sec.experience.map((exp, i) => (
            <div key={i} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: '#1a1a1a' }}>{exp.role || 'Role'}</span>
                <span style={{ fontSize: 9, color: '#888', flexShrink: 0, marginLeft: 8 }}>{exp.period}</span>
              </div>
              {exp.company && <div style={{ fontSize: 10, color: '#666', marginTop: 1 }}>{exp.company}</div>}
              {exp.bullets.filter(Boolean).length > 0 && (
                <ul style={{ margin: '3px 0 0 12px', padding: 0 }}>
                  {exp.bullets.filter(Boolean).map((b, j) => (
                    <li key={j} style={{ fontSize: 10, color: '#555', lineHeight: 1.45, marginBottom: 1 }}>{b}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )

    case 'skills':
      if (sec.skills.length === 0) return null
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
      if (sec.education.length === 0) return null
      return (
        <div>
          {title('Education')}
          {sec.education.map((edu, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 2 }}>
              <span><span style={{ fontWeight: 600, color: '#1a1a1a' }}>{edu.institution || 'School'}</span>{edu.degree ? <span style={{ color: '#666' }}> — {edu.degree}</span> : null}</span>
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
              {p.bullets.filter(Boolean).length > 0 && (
                <ul style={{ margin: '2px 0 0 12px', padding: 0 }}>
                  {p.bullets.filter(Boolean).map((b, j) => (
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
              {item.bullets.filter(Boolean).length > 0 && (
                <ul style={{ margin: '2px 0 0 12px', padding: 0 }}>
                  {item.bullets.filter(Boolean).map((b, k) => (
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
      <EditSection label="Contact" expanded={expandedSec === 'contact'} onToggle={() => toggle('contact')}>
        <Field label="Name" value={content.contact.name} onChange={v => updateContact('name', v)} />
        <Field label="Email" value={content.contact.email} onChange={v => updateContact('email', v)} />
        <Field label="Phone" value={content.contact.phone ?? ''} onChange={v => updateContact('phone', v)} />
        <Field label="Location" value={content.contact.location} onChange={v => updateContact('location', v)} />
        <Field label="LinkedIn" value={content.contact.linkedin ?? ''} onChange={v => updateContact('linkedin', v)} />
        <Field label="GitHub" value={content.contact.github ?? ''} onChange={v => updateContact('github', v)} />
      </EditSection>

      {/* Summary */}
      <EditSection label="Summary" expanded={expandedSec === 'summary'} onToggle={() => toggle('summary')}>
        <textarea value={content.summary} onChange={e => updateSummary(e.target.value)} placeholder="Professional summary..." style={taStyle(C)} />
      </EditSection>

      {/* Experience */}
      <EditSection label={`Experience (${content.experience.length})`} expanded={expandedSec === 'experience'} onToggle={() => toggle('experience')}>
        {content.experience.map((exp, i) => (
          <div key={i} style={{ padding: '6px', borderRadius: 6, background: C.bg, border: `0.5px solid ${C.border}`, marginBottom: 6 }}>
            <div style={{ display: 'flex', gap: 4, marginBottom: 3 }}>
              <input value={exp.role} onChange={e => { const u = [...content.experience]; u[i] = { ...exp, role: e.target.value }; onChange({ ...content, experience: u }) }} placeholder="Role" style={si(C)} />
              <input value={exp.company} onChange={e => { const u = [...content.experience]; u[i] = { ...exp, company: e.target.value }; onChange({ ...content, experience: u }) }} placeholder="Company" style={si(C)} />
            </div>
            <input value={exp.period} onChange={e => { const u = [...content.experience]; u[i] = { ...exp, period: e.target.value }; onChange({ ...content, experience: u }) }} placeholder="Period" style={{ ...si(C), width: 100, marginBottom: 3 }} />
            {exp.bullets.map((b, j) => (
              <div key={j} style={{ display: 'flex', gap: 3, alignItems: 'center', marginBottom: 2 }}>
                <span style={{ fontSize: 9, color: C.subtle }}>•</span>
                <input value={b} onChange={e => { const u = [...content.experience]; const bl = [...exp.bullets]; bl[j] = e.target.value; u[i] = { ...exp, bullets: bl }; onChange({ ...content, experience: u }) }} style={si(C)} />
                <button onClick={() => { const u = [...content.experience]; u[i] = { ...exp, bullets: exp.bullets.filter((_, k) => k !== j) }; onChange({ ...content, experience: u }) }} style={xbtn(C)}>×</button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 4 }}>
              <button onClick={() => { const u = [...content.experience]; u[i] = { ...exp, bullets: [...exp.bullets, ''] }; onChange({ ...content, experience: u }) }} style={minibtn(C)}>+ Bullet</button>
              <button onClick={() => onChange({ ...content, experience: content.experience.filter((_, j) => j !== i) })} style={{ ...minibtn(C), color: C.red }}>Remove</button>
            </div>
          </div>
        ))}
        <button onClick={() => onChange({ ...content, experience: [...content.experience, { company: '', role: '', period: '', bullets: [] }] })} style={addbtn(C)}>+ Add Experience</button>
      </EditSection>

      {/* Education */}
      <EditSection label={`Education (${content.education.length})`} expanded={expandedSec === 'education'} onToggle={() => toggle('education')}>
        {content.education.map((edu, i) => (
          <div key={i} style={{ padding: '6px', borderRadius: 6, background: C.bg, border: `0.5px solid ${C.border}`, marginBottom: 4 }}>
            <div style={{ display: 'flex', gap: 4, marginBottom: 3 }}>
              <input value={edu.institution} onChange={e => { const u = [...content.education]; u[i] = { ...edu, institution: e.target.value }; onChange({ ...content, education: u }) }} placeholder="School" style={si(C)} />
              <input value={edu.degree} onChange={e => { const u = [...content.education]; u[i] = { ...edu, degree: e.target.value }; onChange({ ...content, education: u }) }} placeholder="Degree" style={si(C)} />
            </div>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input value={edu.year} onChange={e => { const u = [...content.education]; u[i] = { ...edu, year: e.target.value }; onChange({ ...content, education: u }) }} placeholder="Year" style={{ ...si(C), width: 80 }} />
              <button onClick={() => onChange({ ...content, education: content.education.filter((_, j) => j !== i) })} style={{ ...minibtn(C), color: C.red, marginLeft: 'auto' }}>Remove</button>
            </div>
          </div>
        ))}
        <button onClick={() => onChange({ ...content, education: [...content.education, { institution: '', degree: '', year: '' }] })} style={addbtn(C)}>+ Add Education</button>
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
          <input placeholder="Type skill + Enter..." style={{ width: '100%', padding: '5px 8px', fontSize: 10, borderRadius: 6, border: `1px solid ${C.border}`, background: C.bg, color: C.text, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }} />
        </form>
      </EditSection>

      {/* Languages — if present */}
      {presentSections.includes('languages') && (
        <EditSection label={`Languages (${(content.languages ?? []).length})`} expanded={expandedSec === 'languages'} onToggle={() => toggle('languages')}>
          {(content.languages ?? []).map((l, i) => (
            <div key={i} style={{ display: 'flex', gap: 3, marginBottom: 3, alignItems: 'center' }}>
              <input value={l.lang} onChange={e => { const u = [...(content.languages ?? [])]; u[i] = { ...l, lang: e.target.value }; onChange({ ...content, languages: u }) }} placeholder="Language" style={si(C)} />
              <input value={l.level} onChange={e => { const u = [...(content.languages ?? [])]; u[i] = { ...l, level: e.target.value }; onChange({ ...content, languages: u }) }} placeholder="Level" style={{ ...si(C), width: 70 }} />
              <button onClick={() => onChange({ ...content, languages: (content.languages ?? []).filter((_, j) => j !== i) })} style={xbtn(C)}>×</button>
            </div>
          ))}
          <button onClick={() => onChange({ ...content, languages: [...(content.languages ?? []), { lang: '', level: '' }] })} style={addbtn(C)}>+ Add Language</button>
        </EditSection>
      )}

      {/* Projects — if present */}
      {presentSections.includes('projects') && (
        <EditSection label={`Projects (${(content.projects ?? []).length})`} expanded={expandedSec === 'projects'} onToggle={() => toggle('projects')}>
          {(content.projects ?? []).map((p, i) => (
            <div key={i} style={{ padding: '6px', borderRadius: 6, background: C.bg, border: `0.5px solid ${C.border}`, marginBottom: 4 }}>
              <input value={p.name} onChange={e => { const u = [...(content.projects ?? [])]; u[i] = { ...p, name: e.target.value }; onChange({ ...content, projects: u }) }} placeholder="Project name" style={{ ...si(C), width: '100%', marginBottom: 3 }} />
              <input value={p.url ?? ''} onChange={e => { const u = [...(content.projects ?? [])]; u[i] = { ...p, url: e.target.value }; onChange({ ...content, projects: u }) }} placeholder="URL" style={{ ...si(C), width: '100%', marginBottom: 3 }} />
              <div style={{ display: 'flex', gap: 4 }}>
                <button onClick={() => onChange({ ...content, projects: (content.projects ?? []).filter((_, j) => j !== i) })} style={{ ...minibtn(C), color: C.red }}>Remove</button>
              </div>
            </div>
          ))}
          <button onClick={() => onChange({ ...content, projects: [...(content.projects ?? []), { name: '', bullets: [] }] })} style={addbtn(C)}>+ Add Project</button>
        </EditSection>
      )}

      {/* Certifications — if present */}
      {presentSections.includes('certifications') && (
        <EditSection label={`Certifications (${(content.certifications ?? []).length})`} expanded={expandedSec === 'certifications'} onToggle={() => toggle('certifications')}>
          {(content.certifications ?? []).map((c, i) => (
            <div key={i} style={{ padding: '6px', borderRadius: 6, background: C.bg, border: `0.5px solid ${C.border}`, marginBottom: 4 }}>
              <input value={c.name} onChange={e => { const u = [...(content.certifications ?? [])]; u[i] = { ...c, name: e.target.value }; onChange({ ...content, certifications: u }) }} placeholder="Name" style={{ ...si(C), width: '100%', marginBottom: 3 }} />
              <input value={c.issuer} onChange={e => { const u = [...(content.certifications ?? [])]; u[i] = { ...c, issuer: e.target.value }; onChange({ ...content, certifications: u }) }} placeholder="Issuer" style={{ ...si(C), width: '100%', marginBottom: 3 }} />
              <div style={{ display: 'flex', gap: 4 }}>
                <button onClick={() => onChange({ ...content, certifications: (content.certifications ?? []).filter((_, j) => j !== i) })} style={{ ...minibtn(C), color: C.red }}>Remove</button>
              </div>
            </div>
          ))}
          <button onClick={() => onChange({ ...content, certifications: [...(content.certifications ?? []), { name: '', issuer: '', date: '' }] })} style={addbtn(C)}>+ Add Certification</button>
        </EditSection>
      )}

      {/* Custom Sections */}
      {(content.custom ?? []).map((cs, i) => (
        <EditSection key={cs.id} label={cs.title || `Custom ${i + 1}`} expanded={expandedSec === `custom:${cs.id}`} onToggle={() => toggle(`custom:${cs.id}`)}>
          <div style={{ padding: '6px', borderRadius: 6, background: C.bg, border: `0.5px solid ${C.border}`, marginBottom: 6 }}>
            <input value={cs.title} onChange={e => {
              const u = [...(content.custom ?? [])]; u[i] = { ...cs, title: e.target.value }; onChange({ ...content, custom: u })
            }} placeholder="Section title" style={{ ...si(C), width: '100%', marginBottom: 4 }} />
            {cs.items.map((item, j) => (
              <div key={j} style={{ padding: '4px', borderRadius: 4, background: C.card, border: `0.5px solid ${C.border}`, marginBottom: 4 }}>
                <div style={{ display: 'flex', gap: 3, marginBottom: 2 }}>
                  <input value={item.title ?? ''} onChange={e => {
                    const u = [...(content.custom ?? [])]; u[i] = { ...cs, items: cs.items.map((it, k) => k === j ? { ...it, title: e.target.value } : it) }; onChange({ ...content, custom: u })
                  }} placeholder="Item title" style={si(C)} />
                  <input value={item.subtitle ?? ''} onChange={e => {
                    const u = [...(content.custom ?? [])]; u[i] = { ...cs, items: cs.items.map((it, k) => k === j ? { ...it, subtitle: e.target.value } : it) }; onChange({ ...content, custom: u })
                  }} placeholder="Subtitle" style={si(C)} />
                </div>
                <input value={item.period ?? ''} onChange={e => {
                  const u = [...(content.custom ?? [])]; u[i] = { ...cs, items: cs.items.map((it, k) => k === j ? { ...it, period: e.target.value } : it) }; onChange({ ...content, custom: u })
                }} placeholder="Period" style={{ ...si(C), width: 80, marginBottom: 2 }} />
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
                  }} style={minibtn(C)}>+ Bullet</button>
                  <button onClick={() => {
                    const u = [...(content.custom ?? [])]; u[i] = { ...cs, items: cs.items.filter((_, idx) => idx !== j) }; onChange({ ...content, custom: u })
                  }} style={{ ...minibtn(C), color: C.red }}>Remove Item</button>
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 4 }}>
              <button onClick={() => {
                const u = [...(content.custom ?? [])]; u[i] = { ...cs, items: [...cs.items, { bullets: [] }] }; onChange({ ...content, custom: u })
              }} style={minibtn(C)}>+ Item</button>
              <button onClick={() => onChange({ ...content, custom: (content.custom ?? []).filter((_, idx) => idx !== i) })} style={{ ...minibtn(C), color: C.red }}>Delete Section</button>
            </div>
          </div>
        </EditSection>
      ))}

      {/* ── Add Section — show missing sections + custom ── */}
      {(missingSections.length > 0 || true) && (
        <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 8, marginTop: 4 }}>
          <div style={{ fontSize: 9, fontWeight: 600, color: C.subtle, marginBottom: 6, textTransform: 'uppercase' }}>Add Section</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {missingSections.map(id => (
              <button key={id} onClick={() => onAddSection(id)} style={{ fontSize: 9, padding: '4px 10px', borderRadius: 999, background: 'transparent', color: C.primary, border: `1px solid ${C.primary}30`, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
                + {id.charAt(0).toUpperCase() + id.slice(1)}
              </button>
            ))}
            <button key="custom" onClick={() => onAddSection('custom')} style={{ fontSize: 9, padding: '4px 10px', borderRadius: 999, background: 'transparent', color: C.teal, border: `1px solid ${C.teal}30`, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
              + Custom Section
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tiny Components ──────────────────────────────────────────────────────────────

function EditSection({ label, expanded, onToggle, children }: { label: string; expanded: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div>
      <button onClick={onToggle} style={{ width: '100%', padding: '6px 0', display: 'flex', justifyContent: 'space-between', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 10, fontWeight: 600, color: C.text, borderBottom: expanded ? `1px solid ${C.border}` : 'none' }}>
        {label}<span style={{ fontSize: 9, color: C.subtle }}>{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && <div style={{ padding: '6px 0' }}>{children}</div>}
    </div>
  )
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
      <span style={{ fontSize: 9, color: C.muted, width: 50, flexShrink: 0 }}>{label}</span>
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
      <div style={{ width: 22, height: 22, border: '2.5px solid rgba(24,95,165,0.15)', borderTopColor: C.primary, borderRadius: '50%', animation: 'rv-spin 0.7s linear infinite' }} />
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
