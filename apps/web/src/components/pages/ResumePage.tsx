'use client'

import React, { useState, useEffect, useRef } from 'react'
import { TopBar } from '@/components/layout/TopBar'
import { Btn, useToast, useConfirm } from '@/components/ui'
import { useApi, apiMutate } from '@/lib/hooks'
import type { ResumeListItem, ResumeContent, Resume, Job, ScoreResult, Suggestion, TemplateOptions } from '@/lib/types'
import { CoverLetterModal } from '@/components/resume/CoverLetterModal'
import { TemplateModal, TEMPLATES } from '@/components/resume/TemplateModal'
import { ResumeRenderer } from '@/components/resume/ResumeRenderer'
import { ContactSection } from '@/components/resume/ContactSection'
import { SummarySection } from '@/components/resume/SummarySection'
import { ExperienceSection } from '@/components/resume/ExperienceSection'
import { SkillsSection } from '@/components/resume/SkillsSection'
import { EducationSection } from '@/components/resume/EducationSection'
import { LanguagesSection } from '@/components/resume/LanguagesSection'
import { ProjectsSection } from '@/components/resume/ProjectsSection'
import { CertificationsSection } from '@/components/resume/CertificationsSection'
import { CustomSection } from '@/components/resume/CustomSection'
import { AiPanel } from '@/components/resume/AiPanel'
import type { DragHandleProps } from '@/components/resume/SectionHeader'
import type { AiFieldContext } from '@/components/resume/AiFieldSuggestion'

// ── Constants ─────────────────────────────────────────────────────────────────

const EMPTY_CONTENT: ResumeContent = {
  contact:    { name: '', email: '', location: '' },
  summary:    '',
  experience: [],
  education:  [],
  skills:     [],
}

const DEFAULT_ORDER = ['summary', 'experience', 'skills', 'education', 'languages']

const ADDABLE_SECTIONS = [
  { id: 'summary',          label: 'Summary' },
  { id: 'experience',       label: 'Experience' },
  { id: 'skills',           label: 'Skills' },
  { id: 'education',        label: 'Education' },
  { id: 'languages',        label: 'Languages' },
  { id: 'projects',         label: 'Projects' },
  { id: 'certifications',   label: 'Certifications' },
]

// ── Completeness ──────────────────────────────────────────────────────────────

function calcCompleteness(c: ResumeContent): { score: number; tips: string[] } {
  const tips: string[] = []; let score = 0
  if (c.contact.name)     score += 10; else tips.push('Add your name')
  if (c.contact.email)    score += 6;  else tips.push('Add email')
  if (c.contact.location) score += 5;  else tips.push('Add location')
  if (c.contact.phone)    score += 4;  else tips.push('Add phone')
  if (c.contact.linkedin) score += 5;  else tips.push('Add LinkedIn')
  const words = c.summary?.trim().split(/\s+/).filter(Boolean).length ?? 0
  if (words >= 30) score += 15; else if (words > 0) { score += 7; tips.push('Expand summary to 30+ words') } else tips.push('Write a summary')
  const expC = c.experience?.length ?? 0
  if (expC >= 2) score += 25; else if (expC === 1) { score += 12; tips.push('Add more experience') } else tips.push('Add work experience')
  const skillC = c.skills?.length ?? 0
  if (skillC >= 5) score += 15; else if (skillC > 0) { score += 7; tips.push('Add more skills (5+)') } else tips.push('Add skills')
  if ((c.education?.length ?? 0) >= 1) score += 10; else tips.push('Add education')
  if ((c.languages?.length ?? 0) >= 1) score += 5
  return { score: Math.min(100, score), tips }
}

function CompletenessBar({ content }: { content: ResumeContent }) {
  const { score, tips } = calcCompleteness(content)
  const color = score >= 80 ? '#3B6D11' : score >= 50 ? '#185FA5' : '#854F0B'
  const [showTips, setShowTips] = useState(false)
  return (
    <div style={{ marginBottom: 12, padding: '8px 12px', background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
        <span style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-muted)' }}>RESUME COMPLETENESS</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color }}>{score}%</span>
          {tips.length > 0 && (
            <button onClick={() => setShowTips(v => !v)}
              style={{ fontSize: 9, color: '#185FA5', background: 'rgba(24,95,165,0.08)', border: '0.5px solid rgba(24,95,165,0.2)', borderRadius: 10, padding: '1px 7px', cursor: 'pointer' }}>
              {showTips ? 'Hide tips' : `${tips.length} tip${tips.length > 1 ? 's' : ''}`}
            </button>
          )}
          {score === 100 && <span style={{ fontSize: 10, color: '#3B6D11' }}>✓ Complete</span>}
        </div>
      </div>
      <div style={{ height: 5, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${score}%`, height: '100%', background: color, borderRadius: 3, transition: 'width 0.4s ease' }} />
      </div>
      {showTips && tips.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {tips.map(t => (
            <span key={t} style={{ fontSize: 9, background: 'rgba(133,79,11,0.08)', color: '#854F0B', border: '0.5px solid rgba(133,79,11,0.2)', borderRadius: 10, padding: '2px 8px' }}>{t}</span>
          ))}
        </div>
      )}
    </div>
  )
}

// ── NewResumeModal ────────────────────────────────────────────────────────────

function NewResumeModal({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => void }) {
  const [name, setName] = useState('New Resume')
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 10, padding: 20, width: 340, boxShadow: '0 8px 32px rgba(0,0,0,0.15)' }}>
        <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 12 }}>New Resume</div>
        <input autoFocus value={name} onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onCreate(name.trim()); if (e.key === 'Escape') onClose() }}
          placeholder="Resume name…"
          style={{ width: '100%', fontSize: 13, padding: '8px 10px', border: '0.5px solid #185FA5', borderRadius: 6, outline: 'none', boxSizing: 'border-box', color: 'var(--text)', background: 'var(--bg)' }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <Btn small variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn small variant="primary" onClick={() => { if (name.trim()) onCreate(name.trim()) }} disabled={!name.trim()}>Create</Btn>
        </div>
      </div>
    </div>
  )
}

// ── ResumePreview (page-aware preview panel) ──────────────────────────────────

const A4_H = 1123 // px at 96 dpi

type PageFit =
  | { type: 'too-short'; ratio: number }
  | { type: 'one-page';  ratio: number }
  | { type: 'two-page';  ratio: number }
  | { type: 'too-long';  ratio: number; pages: number }

function computePageFit(h: number): PageFit {
  const ratio = h / A4_H
  if (ratio < 0.5)  return { type: 'too-short', ratio }
  if (ratio <= 1.15) return { type: 'one-page',  ratio }
  if (ratio <= 2.0)  return { type: 'two-page',  ratio }
  return { type: 'too-long', ratio, pages: Math.ceil(ratio) }
}

function ResumePreview({ content, templateId, templateOptions }: {
  content:         ResumeContent
  templateId:      string
  templateOptions: TemplateOptions
}) {
  const innerRef                    = useRef<HTMLDivElement>(null)
  const [height, setHeight]         = useState(0)
  const [fit,    setFit]            = useState<PageFit | null>(null)

  // Measure rendered height using ResizeObserver
  useEffect(() => {
    const el = innerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const h = entries[0]?.contentRect.height ?? el.scrollHeight
      setHeight(h)
      setFit(computePageFit(h))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const isTwoPage = fit?.type === 'two-page' || fit?.type === 'too-long'

  return (
    <div style={{ maxWidth: 794, margin: '0 auto' }}>

      {/* Status bar */}
      {fit && (
        <div style={{ marginBottom: 10 }}>
          {fit.type === 'too-short' && (
            <div style={{ padding: '10px 14px', background: 'rgba(163,45,45,0.06)', border: '0.5px solid rgba(163,45,45,0.25)', borderRadius: 8, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span style={{ fontSize: 18, lineHeight: 1 }}>📝</span>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#A32D2D' }}>Resume is too sparse — {Math.round(fit.ratio * 100)}% of a page</div>
                <div style={{ fontSize: 11, color: '#A32D2D', opacity: 0.75, marginTop: 2 }}>Add more experience bullets, skills, or expand your summary to fill the page</div>
              </div>
            </div>
          )}
          {fit.type === 'too-long' && (
            <div style={{ padding: '8px 14px', background: 'rgba(133,79,11,0.06)', border: '0.5px solid rgba(133,79,11,0.25)', borderRadius: 8, fontSize: 11, color: '#854F0B' }}>
              ⚠ Content spans {(fit as {pages:number}).pages} pages — switch to Compact spacing or shorten some sections
            </div>
          )}
          {(fit.type === 'one-page' || fit.type === 'two-page') && (
            <div style={{ padding: '7px 12px', background: 'rgba(24,95,165,0.05)', border: '0.5px solid rgba(24,95,165,0.18)', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 11, fontWeight: 500, color: '#185FA5' }}>
                {fit.type === 'one-page' ? '1 page' : '2 pages'}
              </span>
              {/* Fill bar */}
              <div style={{ flex: 1, height: 5, background: 'rgba(24,95,165,0.12)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: 3, transition: 'width 0.4s ease',
                  background: '#185FA5',
                  width: fit.type === 'one-page'
                    ? `${Math.min(100, Math.round(fit.ratio * 100))}%`
                    : `${Math.round((fit.ratio - 1) * 100)}%`,
                }} />
              </div>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                {fit.type === 'one-page'
                  ? `${Math.round(fit.ratio * 100)}% full`
                  : `Page 2 · ${Math.round((fit.ratio - 1) * 100)}% full`}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Resume paper with page-break overlay */}
      <div style={{ position: 'relative' }}>
        {/* Page-break line (visible only when 2 pages) */}
        {isTwoPage && height > A4_H && (
          <div style={{
            position: 'absolute', top: A4_H, left: -12, right: -12,
            zIndex: 10, pointerEvents: 'none',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <div style={{ flex: 1, borderTop: '2px dashed rgba(163,45,45,0.5)' }} />
            <span style={{ fontSize: 9, color: 'rgba(163,45,45,0.7)', background: 'var(--bg-tertiary)', padding: '2px 8px', borderRadius: 10, border: '0.5px solid rgba(163,45,45,0.25)', whiteSpace: 'nowrap', fontWeight: 500 }}>
              page 2 →
            </span>
            <div style={{ flex: 1, borderTop: '2px dashed rgba(163,45,45,0.5)' }} />
          </div>
        )}

        <div style={{ background: '#fff', borderRadius: 10, overflow: 'hidden', boxShadow: '0 4px 24px rgba(0,0,0,0.12)', border: '0.5px solid var(--border)' }}>
          <div ref={innerRef}>
            <ResumeRenderer content={content} templateId={templateId} templateOptions={templateOptions} />
          </div>
        </div>

        {/* Too-short: visual fill indicator overlay */}
        {fit?.type === 'too-short' && height > 0 && (
          <div style={{
            position: 'absolute', top: height, left: 0, right: 0,
            bottom: 0, pointerEvents: 'none',
            background: 'repeating-linear-gradient(45deg, rgba(163,45,45,0.04) 0px, rgba(163,45,45,0.04) 8px, transparent 8px, transparent 16px)',
            borderTop: '2px dashed rgba(163,45,45,0.3)',
            minHeight: 60,
          }} />
        )}
      </div>
    </div>
  )
}

// ── AddSectionMenu ────────────────────────────────────────────────────────────

function AddSectionMenu({ sectionOrder, onAdd, onAddCustom, onClose }: {
  sectionOrder: string[]
  onAdd:        (id: string) => void
  onAddCustom:  () => void
  onClose:      () => void
}) {
  const available = ADDABLE_SECTIONS.filter(s => !sectionOrder.includes(s.id))
  return (
    <div style={{ position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)', marginBottom: 6, background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 8, boxShadow: '0 4px 20px rgba(0,0,0,0.12)', zIndex: 50, minWidth: 180, overflow: 'hidden' }}>
      <div style={{ padding: '6px 10px', fontSize: 9, fontWeight: 600, color: 'var(--text-muted)', borderBottom: '0.5px solid var(--border)' }}>ADD SECTION</div>
      {available.map(s => (
        <button key={s.id} onClick={() => { onAdd(s.id); onClose() }}
          style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 12px', fontSize: 12, color: 'var(--text)', background: 'none', border: 'none', cursor: 'pointer' }}
          onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-secondary)')}
          onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.background = 'none')}>
          {s.label}
        </button>
      ))}
      <div style={{ borderTop: '0.5px solid var(--border)' }}>
        <button onClick={() => { onAddCustom(); onClose() }}
          style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 12px', fontSize: 12, color: '#185FA5', background: 'none', border: 'none', cursor: 'pointer' }}
          onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-secondary)')}
          onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.background = 'none')}>
          + Custom Section…
        </button>
      </div>
    </div>
  )
}

// ── ResumePage ────────────────────────────────────────────────────────────────

export function ResumePage() {
  const toast = useToast()
  const [confirm, ConfirmDialog] = useConfirm()

  const { data: resumeList, loading: loadingList } = useApi<ResumeListItem[]>('/api/resume')
  const [resumes,          setResumes]          = useState<ResumeListItem[]>([])
  const [selectedResumeId, setSelectedResumeId] = useState<string | null>(null)

  const [content,         setContent]         = useState<ResumeContent | null>(null)
  const [resumeName,      setResumeName]      = useState('My Resume')
  const [templateId,      setTemplateId]      = useState('clean')
  const [templateOptions, setTemplateOptions] = useState<TemplateOptions>({})
  const [previewMode,     setPreviewMode]     = useState(false)
  const [loadingCont,     setLoadingCont]     = useState(false)
  const [saving,      setSaving]      = useState(false)
  const [dirty,       setDirty]       = useState(false)
  const [editSection, setEditSection] = useState<string | null>(null)

  const { data: jobData } = useApi<{ jobs: Job[] }>('/api/jobs?pageSize=30')
  const [jobs,          setJobs]          = useState<Job[]>([])
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)

  const [scoreResult, setScoreResult] = useState<ScoreResult | null>(null)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [scoring,     setScoring]     = useState(false)
  const [suggesting,  setSuggesting]  = useState(false)

  const [showTemplates,   setShowTemplates]   = useState(false)
  const [showCoverLetter, setShowCoverLetter] = useState(false)
  const [showNewResume,   setShowNewResume]   = useState(false)
  const [creatingResume,  setCreatingResume]  = useState(false)
  const [showAddSection,  setShowAddSection]  = useState(false)

  // Section ordering
  const [sectionOrder,    setSectionOrder]    = useState<string[]>(DEFAULT_ORDER)
  const sectionDragRef = useRef<number | null>(null)
  const [sectionDragOver, setSectionDragOver] = useState<number | null>(null)

  const initDone = useRef(false)

  useEffect(() => {
    if (!resumeList) return
    setResumes(resumeList)
    if (!selectedResumeId && resumeList.length > 0) {
      const def = resumeList.find(r => r.isDefault) ?? resumeList[0]
      setSelectedResumeId(def.id)
    }
  }, [resumeList])

  useEffect(() => {
    if (loadingList || initDone.current) return
    if (!resumeList) return
    initDone.current = true
    if (resumeList.length === 0) {
      apiMutate<Resume>('/api/resume', 'POST', {
        name: 'My Resume', content: EMPTY_CONTENT, isDefault: true,
      }).then(({ data, error }) => {
        if (data) {
          setResumes([{ id: data.id, name: data.name, isDefault: data.isDefault, createdAt: data.createdAt, updatedAt: data.updatedAt }])
          setSelectedResumeId(data.id)
          setContent(EMPTY_CONTENT)
          setResumeName(data.name)
          toast.info('Resume created', 'Fill in your details to get started')
        } else toast.error('Error', error ?? 'Could not create resume')
      })
    }
  }, [resumeList, loadingList])

  useEffect(() => {
    if (!selectedResumeId) return
    setLoadingCont(true); setDirty(false); setScoreResult(null); setSuggestions([])
    fetch(`/api/resume/${selectedResumeId}`)
      .then(r => r.json())
      .then((r: Resume) => {
        const c = (r.content ?? EMPTY_CONTENT) as ResumeContent
        setContent(c)
        setResumeName(r.name)
        setTemplateId(r.templateId ?? 'clean')
        setTemplateOptions((r.templateOptions ?? {}) as TemplateOptions)
        setSectionOrder(c.sectionOrder ?? DEFAULT_ORDER)
      })
      .catch(() => toast.error('Error', 'Could not load resume'))
      .finally(() => setLoadingCont(false))
  }, [selectedResumeId])

  useEffect(() => { if (jobData?.jobs) setJobs(jobData.jobs) }, [jobData])

  useEffect(() => {
    if (!selectedJobId || !content || jobs.length === 0) return
    runAnalysis(content, selectedJobId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJobId, jobs])

  function patch(updater: (prev: ResumeContent) => ResumeContent) {
    setContent(prev => {
      if (!prev) return prev
      setDirty(true)
      return updater(prev)
    })
  }

  function applyFormat([prefix, suffix]: [string, string]) {
    const el = document.activeElement
    if (!el || !(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) {
      toast.info('Click into a text field first', 'Select text in any section to format it'); return
    }
    const start = el.selectionStart ?? 0; const end = el.selectionEnd ?? 0
    if (start === end) {
      if (prefix === '# ' || prefix === '## ' || prefix === '• ') {
        const before = el.value.substring(0, start)
        const lineStart = before.lastIndexOf('\n') + 1
        const lineEnd = el.value.indexOf('\n', start)
        const lineContent = el.value.substring(lineStart, lineEnd === -1 ? el.value.length : lineEnd)
        if (lineContent.startsWith(prefix)) {
          el.value = el.value.substring(0, lineStart) + lineContent.slice(prefix.length) + el.value.substring(lineEnd === -1 ? el.value.length : lineEnd)
          el.selectionStart = el.selectionEnd = start - prefix.length
        } else {
          el.value = el.value.substring(0, lineStart) + prefix + lineContent + el.value.substring(lineEnd === -1 ? el.value.length : lineEnd)
          el.selectionStart = el.selectionEnd = start + prefix.length
        }
      } else {
        const wrapped = prefix + suffix
        el.value = el.value.substring(0, start) + wrapped + el.value.substring(end)
        el.selectionStart = el.selectionEnd = start + wrapped.length
      }
    } else {
      const selected = el.value.substring(start, end)
      const wrapped = prefix + selected + suffix
      el.value = el.value.substring(0, start) + wrapped + el.value.substring(end)
      el.selectionStart = start; el.selectionEnd = start + wrapped.length
    }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')?.set ??
                   Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')?.set
    if (setter) { setter.call(el, el.value); el.dispatchEvent(new Event('input', { bubbles: true })) }
    el.focus(); setDirty(true)
  }

  async function runAnalysis(c: ResumeContent, jobId: string) {
    const job = jobs.find(j => j.id === jobId); if (!job) return
    setScoring(true); setSuggesting(true)
    const [scoreRes, suggestRes] = await Promise.allSettled([
      apiMutate<ScoreResult>('/api/ai/score', 'POST', { resumeContent: c, jobTitle: job.role, jobCompany: job.company, jobDescription: job.description ?? undefined }),
      apiMutate<{ suggestions: Suggestion[] }>('/api/ai/suggest', 'POST', { resumeContent: c, jobTitle: job.role, jobCompany: job.company, jobDescription: job.description ?? undefined }),
    ])
    setScoring(false); setSuggesting(false)
    if (scoreRes.status === 'fulfilled' && scoreRes.value.data) setScoreResult(scoreRes.value.data)
    else { const msg = scoreRes.status === 'fulfilled' ? (scoreRes.value.error ?? 'Unknown') : scoreRes.reason; toast.error('Analysis failed', typeof msg === 'string' ? msg : 'Check ANTHROPIC_API_KEY') }
    if (suggestRes.status === 'fulfilled' && suggestRes.value.data?.suggestions) setSuggestions(suggestRes.value.data.suggestions)
  }

  async function handleSave() {
    if (!selectedResumeId || !content) return
    setSaving(true)
    const { error } = await apiMutate(`/api/resume/${selectedResumeId}`, 'PATCH', {
      name: resumeName, content: { ...content, sectionOrder }, templateId, templateOptions,
    })
    setSaving(false)
    if (error) toast.error('Save failed', error)
    else { setDirty(false); toast.success('Saved', 'Resume updated successfully'); if (selectedJobId) runAnalysis(content, selectedJobId) }
  }

  async function handleCreateResume(name: string) {
    setCreatingResume(true); setShowNewResume(false)
    const { data, error } = await apiMutate<Resume>('/api/resume', 'POST', { name, content: EMPTY_CONTENT, isDefault: false })
    setCreatingResume(false)
    if (data) {
      const item: ResumeListItem = { id: data.id, name: data.name, isDefault: data.isDefault, createdAt: data.createdAt, updatedAt: data.updatedAt }
      setResumes(prev => [...prev, item]); setSelectedResumeId(data.id)
      toast.success('Resume created', `"${name}" is ready to edit`)
    } else toast.error('Error', error ?? 'Could not create resume')
  }

  function applySuggestion(i: number) {
    setSuggestions(prev => { const n = [...prev]; n[i] = { ...n[i], applied: true }; return n })
    setDirty(true)
    if (scoreResult?.missingKeywords.length) {
      setContent(prev => {
        if (!prev) return prev
        const existing = new Set(prev.skills?.map(s => s.toLowerCase()) ?? [])
        const newSkills = scoreResult.missingKeywords.filter(kw => !existing.has(kw.toLowerCase()))
        if (newSkills.length === 0) return prev
        return { ...prev, skills: [...(prev.skills ?? []), ...newSkills] }
      })
      toast.success('Skills updated', `Added ${scoreResult.missingKeywords.length} missing keyword(s)`)
    } else toast.success('Noted', 'Suggestion marked as applied')
  }

  // ── Section ordering ──────────────────────────────────────────────────────

  function handleSectionDrop(targetIdx: number) {
    const from = sectionDragRef.current
    if (from === null || from === targetIdx) { setSectionDragOver(null); return }
    const next = [...sectionOrder]; const [item] = next.splice(from, 1); next.splice(targetIdx, 0, item)
    setSectionOrder(next); sectionDragRef.current = null; setSectionDragOver(null); setDirty(true)
  }

  function removeSection(id: string) {
    setSectionOrder(prev => prev.filter(s => s !== id)); setDirty(true)
  }

  function addSection(id: string) {
    setSectionOrder(prev => [...prev, id]); setDirty(true)
  }

  function addCustomSection() {
    const id = `custom_${Date.now()}`
    patch(p => ({ ...p, custom: [...(p.custom ?? []), { id, title: 'CUSTOM SECTION', items: [] }] }))
    setSectionOrder(prev => [...prev, id])
  }

  function getDragHandleProps(i: number): DragHandleProps {
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => { e.stopPropagation(); sectionDragRef.current = i },
    }
  }

  // ── Job context for AI ────────────────────────────────────────────────────

  const selectedJob  = jobs.find(j => j.id === selectedJobId) ?? null
  const jobContext: AiFieldContext = selectedJob ? {
    jobTitle:       selectedJob.role,
    jobCompany:     selectedJob.company,
    jobDescription: selectedJob.description ?? undefined,
  } : {}

  // ── Render section ────────────────────────────────────────────────────────

  function renderSection(sectionId: string, sectionIdx: number) {
    if (!content) return null
    const dh = getDragHandleProps(sectionIdx)

    if (sectionId === 'summary') return (
      <SummarySection key={sectionId}
        summary={content.summary}
        matchedKeywords={scoreResult?.matchedKeywords ?? []}
        editing={editSection === 'summary'}
        onEdit={() => setEditSection('summary')}
        onBlur={() => setEditSection(null)}
        onChange={s => patch(p => ({ ...p, summary: s }))}
        jobContext={jobContext}
        dragHandleProps={dh}
        onRemove={() => removeSection(sectionId)}
      />
    )
    if (sectionId === 'experience') return (
      <ExperienceSection key={sectionId}
        experience={content.experience}
        jobContext={jobContext}
        onChange={exp => patch(p => ({ ...p, experience: exp }))}
        dragHandleProps={dh}
        onRemove={() => removeSection(sectionId)}
      />
    )
    if (sectionId === 'skills') return (
      <SkillsSection key={sectionId}
        skills={content.skills}
        matchedKeywords={scoreResult?.matchedKeywords ?? []}
        onChange={sk => patch(p => ({ ...p, skills: sk }))}
        dragHandleProps={dh}
        onRemove={() => removeSection(sectionId)}
      />
    )
    if (sectionId === 'education') return (
      <EducationSection key={sectionId}
        education={content.education}
        onChange={ed => patch(p => ({ ...p, education: ed }))}
        dragHandleProps={dh}
        onRemove={() => removeSection(sectionId)}
      />
    )
    if (sectionId === 'languages') return (
      <LanguagesSection key={sectionId}
        languages={content.languages ?? []}
        onChange={langs => patch(p => ({ ...p, languages: langs.length > 0 ? langs : undefined }))}
        dragHandleProps={dh}
        onRemove={() => removeSection(sectionId)}
      />
    )
    if (sectionId === 'projects') return (
      <ProjectsSection key={sectionId}
        projects={content.projects ?? []}
        jobContext={jobContext}
        onChange={projects => patch(p => ({ ...p, projects: projects.length > 0 ? projects : undefined }))}
        dragHandleProps={dh}
        onRemove={() => removeSection(sectionId)}
      />
    )
    if (sectionId === 'certifications') return (
      <CertificationsSection key={sectionId}
        certifications={content.certifications ?? []}
        onChange={certs => patch(p => ({ ...p, certifications: certs.length > 0 ? certs : undefined }))}
        dragHandleProps={dh}
        onRemove={() => removeSection(sectionId)}
      />
    )
    if (sectionId.startsWith('custom_')) {
      const entry = content.custom?.find(c => c.id === sectionId)
      if (!entry) return null
      return (
        <CustomSection key={sectionId}
          entry={entry}
          jobContext={jobContext}
          onChange={e => patch(p => ({ ...p, custom: (p.custom ?? []).map(c => c.id === sectionId ? e : c) }))}
          onRemove={() => {
            patch(p => ({ ...p, custom: (p.custom ?? []).filter(c => c.id !== sectionId) }))
            removeSection(sectionId)
          }}
          dragHandleProps={dh}
        />
      )
    }
    return null
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <ConfirmDialog />
      <TopBar title="Resume">
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <select value={selectedResumeId ?? ''} onChange={async e => {
            const next = e.target.value
            if (dirty) {
              const ok = await confirm({ title: 'Discard changes?', message: 'You have unsaved changes. Switching will discard them.', danger: true, confirmLabel: 'Discard' })
              if (!ok) return
            }
            setSelectedResumeId(next)
          }} style={{ fontSize: 11, padding: '4px 8px', border: '0.5px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)', outline: 'none', maxWidth: 160 }}>
            {resumes.map(r => <option key={r.id} value={r.id}>{r.name}{r.isDefault ? ' ★' : ''}</option>)}
          </select>
          <button onClick={() => setShowNewResume(true)} disabled={creatingResume} title="New resume"
            style={{ fontSize: 13, lineHeight: 1, padding: '3px 7px', border: '0.5px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: '#185FA5', cursor: 'pointer' }}>
            {creatingResume ? '…' : '+'}
          </button>
        </div>
        <Btn variant={previewMode ? 'primary' : 'ghost'} onClick={() => setPreviewMode(v => !v)}>
          {previewMode ? '✎ Edit' : '◻ Preview'}
        </Btn>
        <Btn variant="ghost" onClick={() => setShowTemplates(true)}>⊞ Templates</Btn>
        <select value={selectedJobId ?? ''} onChange={e => setSelectedJobId(e.target.value || null)}
          style={{ fontSize: 11, padding: '4px 8px', border: '0.5px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)', outline: 'none', maxWidth: 200 }}>
          <option value="">— No tailoring —</option>
          {jobs.map(j => <option key={j.id} value={j.id}>{j.company} · {j.role}</option>)}
        </select>
        <Btn variant="ghost" onClick={() => {
          if (!selectedJobId) { toast.info('Select a job first', 'Choose a job from the dropdown'); return }
          setShowCoverLetter(true)
        }}>✉ Cover Letter</Btn>
        <Btn variant="ghost" onClick={() => {
          if (!selectedResumeId) { toast.info('Select a resume first'); return }
          window.open(`/resume/${selectedResumeId}/print`, '_blank')
        }}>↓ PDF</Btn>
        <Btn variant="primary" onClick={handleSave} disabled={!dirty || saving}>
          {saving ? 'Saving…' : dirty ? 'Save*' : 'Saved'}
        </Btn>
      </TopBar>

      {loadingCont ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-tertiary)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 28, height: 28, border: '2.5px solid rgba(24,95,165,0.2)', borderTopColor: '#185FA5', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading resume…</div>
          </div>
        </div>
      ) : !content ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-tertiary)' }}>
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Select or create a resume to get started.</div>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden', background: 'var(--bg-tertiary)' }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
            {/* ── PREVIEW MODE ── */}
            {previewMode && <ResumePreview content={content} templateId={templateId} templateOptions={templateOptions} />}
            {/* Format toolbar + Editor (hidden in preview mode) */}
            {!previewMode && (<>

            {/* Format toolbar */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 12, padding: '6px 10px', background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {([
                { key: 'B', label: 'B', title: 'Bold', wrap: ['**', '**'] as [string,string], style: { fontWeight: 700 } },
                { key: 'I', label: 'I', title: 'Italic', wrap: ['_', '_'] as [string,string], style: { fontStyle: 'italic' as const } },
                { key: 'U', label: 'U', title: 'Underline', wrap: ['<u>', '</u>'] as [string,string], style: { textDecoration: 'underline' as const } },
                { key: 'H1', label: 'H1', title: 'Heading 1', wrap: ['# ', ''] as [string,string], style: {} },
                { key: 'H2', label: 'H2', title: 'Heading 2', wrap: ['## ', ''] as [string,string], style: {} },
                { key: '•', label: '•', title: 'Bullet point', wrap: ['• ', ''] as [string,string], style: {} },
              ]).map(f => (
                <button key={f.key} onClick={() => applyFormat(f.wrap)} title={f.title} style={{
                  width: f.key.length > 1 ? 'auto' : 26, height: 26, padding: f.key.length > 1 ? '0 8px' : 0,
                  borderRadius: 4, border: '0.5px solid var(--border)', background: 'var(--bg-secondary)',
                  fontSize: 11, cursor: 'pointer', color: 'var(--text)', ...f.style,
                }}>{f.label}</button>
              ))}
              <div style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 2px' }} />
              <span style={{ fontSize: 10, color: dirty ? '#854F0B' : 'var(--text-muted)' }}>
                {dirty ? '● Unsaved' : '✓ Saved'}
              </span>
            </div>

            {/* Completeness bar */}
            <CompletenessBar content={content} />

            {/* Resume paper */}
            <div style={{ maxWidth: 680, margin: '0 auto', background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 10, padding: '32px 36px' }}>
              {/* Contact (fixed, not draggable) */}
              <ContactSection
                contact={content.contact}
                editing={editSection === 'contact'}
                onEdit={() => setEditSection('contact')}
                onBlur={() => setEditSection(null)}
                onChange={c => patch(p => ({ ...p, contact: c }))}
              />

              {/* Dynamic draggable sections */}
              {sectionOrder.map((sectionId, sectionIdx) => (
                <div key={sectionId}
                  onDragOver={e => { e.preventDefault(); setSectionDragOver(sectionIdx) }}
                  onDragLeave={e => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) setSectionDragOver(null)
                  }}
                  onDrop={() => handleSectionDrop(sectionIdx)}
                  style={{
                    borderRadius: 6,
                    outline: sectionDragOver === sectionIdx ? '1.5px dashed rgba(24,95,165,0.4)' : '1.5px solid transparent',
                    background: sectionDragOver === sectionIdx ? 'rgba(24,95,165,0.02)' : 'transparent',
                    transition: 'outline 0.1s, background 0.1s',
                  }}>
                  {renderSection(sectionId, sectionIdx)}
                </div>
              ))}

              {/* Add Section button */}
              <div style={{ position: 'relative', display: 'flex', justifyContent: 'center', marginTop: 8 }}>
                {showAddSection && (
                  <>
                    <div style={{ position: 'fixed', inset: 0, zIndex: 49 }} onClick={() => setShowAddSection(false)} />
                    <AddSectionMenu
                      sectionOrder={sectionOrder}
                      onAdd={addSection}
                      onAddCustom={addCustomSection}
                      onClose={() => setShowAddSection(false)}
                    />
                  </>
                )}
                <button onClick={() => setShowAddSection(v => !v)}
                  style={{ fontSize: 11, color: '#185FA5', background: 'rgba(24,95,165,0.06)', border: '0.5px dashed rgba(24,95,165,0.3)', borderRadius: 6, padding: '6px 20px', cursor: 'pointer' }}>
                  + Add Section
                </button>
              </div>
            </div>
            </>)}
          </div>

          <AiPanel
            selectedJob={selectedJob}
            scoreResult={scoreResult}
            suggestions={suggestions}
            scoring={scoring}
            suggesting={suggesting}
            noJobSelected={!selectedJobId}
            onApplySuggestion={applySuggestion}
            onAnalyze={() => content && selectedJobId && runAnalysis(content, selectedJobId)}
            onAddKeyword={kw => patch(p => ({ ...p, skills: [...(p.skills ?? []), kw] }))}
          />
        </div>
      )}

      {showTemplates && (
        <TemplateModal
          current={templateId}
          currentOptions={templateOptions}
          onSelect={(id, opts) => {
            setTemplateId(id)
            setTemplateOptions(opts)
            setDirty(true)
            toast.success('Template applied', TEMPLATES.find(t => t.id === id)?.name ?? id)
          }}
          onClose={() => setShowTemplates(false)}
        />
      )}
      {showCoverLetter && content && selectedJob && (
        <CoverLetterModal resumeContent={content} job={selectedJob} onClose={() => setShowCoverLetter(false)} />
      )}
      {showNewResume && (
        <NewResumeModal onClose={() => setShowNewResume(false)} onCreate={handleCreateResume} />
      )}
    </div>
  )
}
