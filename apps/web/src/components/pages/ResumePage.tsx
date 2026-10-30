'use client'

import React, { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { useSession } from 'next-auth/react'
import { useI18n } from '@/lib/i18n'
import { useNav } from '@/lib/nav-context'
import { openApplication } from '@/lib/application-navigation'
import { auditMatchesCurrentMaterials } from '@/lib/application-materials'
import { applicationMaterialAssignment, selectApplicationCoverLetter } from '@/lib/application-material-selection'
import { sameApplicationAudit, type ApplicationAuditIdentity } from '@/lib/application-audit-identity'
import { guardApplicationUnload } from '@/lib/application-unload-guard'
import { createApplicationAnalysisRequestPool } from '@/lib/application-analysis-request'
import { mayApplyResumeRevalidation } from '@/lib/application-resume-revalidation'
import { versionRestoreDisposition } from '@/lib/application-version-restore'
import { mayApplyApplicationAnalysis } from '@/lib/application-analysis-guard'
import { Eye, FileDown, FileText, History, LayoutTemplate, Plus, ShieldCheck, Type, Upload } from 'lucide-react'
import './ResumePage.css'

// Analysis cache is keyed by resume + job so switching versions never discards a
// completed result or accidentally displays another resume's result.
const LS_KEY = 'applymate_last_analysis'
const AUDIT_SUGGESTION_PREFIX = '[Audit] '
type AnalysisCacheEntry = { resumeId: string; jobId: string; resumeUpdatedAt: string | null; score: ScoreResult | null; suggs: Suggestion[] }
let _cachedAnalyses: Record<string, AnalysisCacheEntry> | null = null

function cacheKey(resumeId: string, jobId: string) { return `${resumeId}:${jobId}` }

function loadAnalysisCache() {
  if (_cachedAnalyses) return _cachedAnalyses
  if (typeof window === 'undefined') return null
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LS_KEY) ?? 'null')
    if (!parsed || typeof parsed !== 'object') return null
    if ('resumeId' in parsed && 'jobId' in parsed) {
      const legacy = parsed as AnalysisCacheEntry
      _cachedAnalyses = { [cacheKey(legacy.resumeId, legacy.jobId)]: legacy }
    } else {
      _cachedAnalyses = parsed as Record<string, AnalysisCacheEntry>
    }
    return _cachedAnalyses
  } catch { return null }
}
function isAuditSuggestion(suggestion: Suggestion) {
  return suggestion.text.startsWith(AUDIT_SUGGESTION_PREFIX)
}
function withoutAuditSuggestions(suggestions: Suggestion[]) {
  return suggestions.filter(suggestion => !isAuditSuggestion(suggestion))
}
function getAnalysisCache(resumeId: string | null, jobId: string | null, resumeUpdatedAt: string | null) {
  if (!resumeId || !jobId || !resumeUpdatedAt) return null
  const cached = loadAnalysisCache()?.[cacheKey(resumeId, jobId)] ?? null
  // A tailored resume is revised in place after a failed audit. Never reuse
  // suggestions scored against its previous content.
  return cached?.resumeUpdatedAt === resumeUpdatedAt
    ? cached && { ...cached, suggs: withoutAuditSuggestions(cached.suggs) }
    : null
}
function saveCache(data: { resumeId: string | null; jobId: string | null; resumeUpdatedAt: string | null; score: ScoreResult | null; suggs: Suggestion[]; [k: string]: unknown }) {
  if (!data.jobId || !data.resumeId || !data.resumeUpdatedAt) return
  const entries = loadAnalysisCache() ?? {}
  entries[cacheKey(data.resumeId, data.jobId)] = {
    resumeId: data.resumeId,
    jobId: data.jobId,
    resumeUpdatedAt: data.resumeUpdatedAt,
    score: data.score,
    suggs: withoutAuditSuggestions(data.suggs),
  }
  _cachedAnalyses = entries
  try { localStorage.setItem(LS_KEY, JSON.stringify(entries)) } catch {}
}
type StoredApplicationAudit = {
  resumeId: string
  coverLetterId: string | null
  resumeUpdatedAt?: string
  coverLetterUpdatedAt?: string
  audit: ApplicationAudit
}

type ApplicationAuditResponse = ApplicationAudit & {
  resumeUpdatedAt?: string
  coverLetterUpdatedAt?: string
}

type AuditApplyResponse = {
  audit: ApplicationAudit
  target: ApplicationAuditFinding['target']
  appliedContent: unknown
  resume: Resume | null
  coverLetter: CoverLetter | null
  resumeUpdatedAt?: string
  coverLetterUpdatedAt?: string
}

import { Btn, useToast, useConfirm } from '@/components/ui'
import { useApi, apiMutate, fmtDate, fmtRelative } from '@/lib/hooks'
import { getCachedApiResponse, setCachedApiResponse } from '@/lib/api-cache'
import type { ApplicationAudit, ApplicationAuditFinding, CoverLetter, ResumeListItem, ResumeContent, Resume, Job, ScoreResult, Suggestion, TemplateOptions, Direction } from '@/lib/types'
import { CoverLetterPanel } from '@/components/coverletter/CoverLetterPanel'
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
import { ResumeChangeSummary } from '@/components/resume/ResumeChangeSummary'
import { PersonaPanel } from '@/components/resume/PersonaPanel'
import { FinalConfirmDialog } from '@/components/resume/FinalConfirmDialog'
import { UploadResumeModal } from '@/components/resume/UploadResumeModal'
import { ResumeIntakeDialog } from '@/components/resume/ResumeIntakeDialog'
import type { DragHandleProps } from '@/components/resume/SectionHeader'
import type { AiFieldContext } from '@/components/resume/AiFieldSuggestion'
import { exportApplicationPackLocally } from '@/lib/bundle'
import { downloadResumePdf } from '@/lib/resume-export'
import { analysisTargetKey, replaceSectionSuggestions, shouldPreserveAnalysis, shouldStartAutomaticAnalysis } from '@/lib/resume-analysis-state'
import { formatResumeChangeValue, type ResumeChange, type ResumeChangeSection, type ResumeChangeSource } from '@/lib/resume-change-diff'
import { targetForAuditFinding } from '@/lib/application-audit'

const AI_SUGGESTION_SECTIONS = ['summary', 'skills', 'experience', 'education', 'projects'] as const
type AiSuggestionSection = (typeof AI_SUGGESTION_SECTIONS)[number]

// ── Constants ─────────────────────────────────────────────────────────────────

const EMPTY_CONTENT: ResumeContent = {
  contact:    { name: '', email: '', location: '' },
  summary:    '',
  experience: [],
  education:  [],
  skills:     [],
}

const DEFAULT_ORDER = ['summary', 'experience', 'skills', 'education', 'languages']
const AI_PANEL_MIN_WIDTH = 280
const AI_PANEL_MAX_WIDTH = 520
const AI_PANEL_LEGACY_DEFAULT_WIDTH = 340
const AI_PANEL_DEFAULT_WIDTH = 380
const AI_PANEL_WIDTH_STORAGE_KEY = 'applymate_resume_ai_panel_width'
const RESUME_LIBRARY_MIN_WIDTH = 190
const RESUME_LIBRARY_MAX_WIDTH = 320
const RESUME_LIBRARY_DEFAULT_WIDTH = 230
const RESUME_LIBRARY_COLLAPSED_WIDTH = 54
const RESUME_LIBRARY_COLLAPSE_THRESHOLD = 155
const MAIN_NAV_COLLAPSE_DRAG_DISTANCE = 72
const RESUME_LIBRARY_COLLAPSE_ANIMATION_MS = 180
const MAIN_NAV_COLLAPSE_DELAY_MS = 240

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
  const { t } = useI18n()
  const { score, tips } = calcCompleteness(content)
  const color = score >= 80 ? 'var(--c-success)' : score >= 50 ? 'var(--primary)' : 'var(--c-warning)'
  const [showTips, setShowTips] = useState(false)
  return (
    <div className="resume-completeness">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
        <span style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-muted)' }}>{t('resume.completeness')}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color }}>{score}%</span>
          {tips.length > 0 && (
            <button onClick={() => setShowTips(v => !v)}
              style={{ fontSize: 9, color: 'var(--primary)', background: 'rgba(79,70,229,0.08)', border: '0.5px solid rgba(79,70,229,0.20)', borderRadius: 10, padding: '1px 7px', cursor: 'pointer' }}>
              {showTips ? t('resume.hideTips') : `${tips.length} ${t('resume.tips')}`}
            </button>
          )}
          {score === 100 && <span style={{ fontSize: 10, color: 'var(--c-success)' }}>{t('resume.complete')}</span>}
        </div>
      </div>
      <div style={{ height: 5, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${score}%`, height: '100%', background: color, borderRadius: 3, transition: 'width 0.4s ease' }} />
      </div>
      {showTips && tips.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {tips.map(t => (
            <span key={t} style={{ fontSize: 9, background: 'rgba(217,119,6,0.08)', color: 'var(--c-warning)', border: '0.5px solid rgba(217,119,6,0.20)', borderRadius: 10, padding: '2px 8px' }}>{t}</span>
          ))}
        </div>
      )}
    </div>
  )
}

// ── NewResumeModal ────────────────────────────────────────────────────────────

function NewResumeModal({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => void }) {
  const { t } = useI18n()
  const [name, setName] = useState('New Resume')
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 10, padding: 20, width: 340, boxShadow: '0 8px 32px rgba(0,0,0,0.15)' }}>
        <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 12 }}>{t('resume.newTitle')}</div>
        <input autoFocus value={name} onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onCreate(name.trim()); if (e.key === 'Escape') onClose() }}
          placeholder={t('resume.namePlaceholder')}
          style={{ width: '100%', fontSize: 13, padding: '8px 10px', border: '0.5px solid var(--primary)', borderRadius: 6, outline: 'none', boxSizing: 'border-box', color: 'var(--text)', background: 'var(--bg)' }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <Btn small variant="ghost" onClick={onClose}>{t('resume.cancel')}</Btn>
          <Btn small variant="primary" onClick={() => { if (name.trim()) onCreate(name.trim()) }} disabled={!name.trim()}>{t('resume.create')}</Btn>
        </div>
      </div>
    </div>
  )
}

function RenameResumeModal({ resume, onClose, onRename }: { resume: ResumeListItem; onClose: () => void; onRename: (name: string) => void }) {
  const { t } = useI18n()
  const [name, setName] = useState(resume.name)
  return <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
    <div style={{ background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 10, padding: 20, width: 340, boxShadow: '0 8px 32px rgba(0,0,0,0.15)' }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{t('resume.renameTitle')}</div>
      <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 12 }}>{t('resume.renameHint')}</div>
      <input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onRename(name.trim()); if (e.key === 'Escape') onClose() }} style={{ width: '100%', fontSize: 13, padding: '8px 10px', border: '0.5px solid var(--primary)', borderRadius: 6, outline: 'none', boxSizing: 'border-box', color: 'var(--text)', background: 'var(--bg)' }} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}><Btn small variant="ghost" onClick={onClose}>{t('resume.cancel')}</Btn><Btn small variant="primary" onClick={() => name.trim() && onRename(name.trim())} disabled={!name.trim()}>{t('resume.saveName')}</Btn></div>
    </div>
  </div>
}

// ── AddDirectionDialog ────────────────────────────────────────────────────────

const DIRECTION_COLORS = ['var(--primary)','var(--c-success)','var(--c-warning)','var(--c-danger)','#6B3F9E','#0F7A8C','#B5591A','#2D6B4F']

function AddDirectionDialog({ onClose, onCreate }: {
  onClose: () => void
  onCreate: (d: { name: string; color: string | null; icon: string | null }) => void
}) {
  const { t } = useI18n()
  const [name,  setName]  = useState('')
  const [color, setColor] = useState<string | null>(DIRECTION_COLORS[0])
  const [icon,  setIcon]  = useState('')
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 10, padding: 20, width: 360, boxShadow: '0 8px 32px rgba(0,0,0,0.15)' }}>
        <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 14 }}>{t('direction.addTitle')}</div>
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{t('direction.nameLabel')}</div>
          <input autoFocus value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onCreate({ name: name.trim(), color, icon: icon.trim() || null }); if (e.key === 'Escape') onClose() }}
            placeholder={t('direction.namePlaceholder')}
            style={{ width: '100%', fontSize: 13, padding: '7px 10px', border: '0.5px solid var(--primary)', borderRadius: 6, outline: 'none', boxSizing: 'border-box', color: 'var(--text)', background: 'var(--bg)' }}
          />
        </div>
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{t('direction.color')}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {DIRECTION_COLORS.map(c => (
              <button key={c} onClick={() => setColor(c)}
                style={{ width: 22, height: 22, borderRadius: '50%', background: c, border: color === c ? '2px solid var(--text)' : '2px solid transparent', cursor: 'pointer', padding: 0 }} />
            ))}
            <button onClick={() => setColor(null)}
              style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--border)', border: color === null ? '2px solid var(--text)' : '2px solid transparent', cursor: 'pointer', padding: 0, fontSize: 12, color: 'var(--text-muted)' }}>∅</button>
          </div>
        </div>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{t('direction.icon')}</div>
          <input value={icon} onChange={e => setIcon(e.target.value)} placeholder={t('direction.iconPlaceholder')}
            style={{ width: 60, fontSize: 18, padding: '4px 8px', border: '0.5px solid var(--border)', borderRadius: 6, outline: 'none', textAlign: 'center', background: 'var(--bg)', color: 'var(--text)' }}
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn small variant="ghost" onClick={onClose}>{t('resume.cancel')}</Btn>
          <Btn small variant="primary" onClick={() => { if (name.trim()) onCreate({ name: name.trim(), color, icon: icon.trim() || null }) }} disabled={!name.trim()}>{t('resume.create')}</Btn>
        </div>
      </div>
    </div>
  )
}

// ── ResumePreview (page-aware preview panel) ──────────────────────────────────

const A4_W = 794 // px at 96 dpi
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
  const { t } = useI18n()
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
    <div style={{ maxWidth: A4_W, margin: '0 auto' }}>

      {/* Status bar */}
      {fit && (
        <div style={{ marginBottom: 10 }}>
          {fit.type === 'too-short' && (
            <div style={{ padding: '10px 14px', background: 'rgba(163,45,45,0.06)', border: '0.5px solid rgba(163,45,45,0.25)', borderRadius: 8, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span style={{ fontSize: 18, lineHeight: 1 }}>📝</span>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--c-danger)' }}>Resume is too sparse — {Math.round(fit.ratio * 100)}% of a page</div>
                <div style={{ fontSize: 11, color: 'var(--c-danger)', opacity: 0.75, marginTop: 2 }}>{t('resume.addMoreHint')}</div>
              </div>
            </div>
          )}
          {fit.type === 'too-long' && (
            <div style={{ padding: '8px 14px', background: 'rgba(217,119,6,0.06)', border: '0.5px solid rgba(217,119,6,0.25)', borderRadius: 8, fontSize: 11, color: 'var(--c-warning)' }}>
              ⚠ Content spans {(fit as {pages:number}).pages} pages — switch to Compact spacing or shorten some sections
            </div>
          )}
          {(fit.type === 'one-page' || fit.type === 'two-page') && (
            <div style={{ padding: '7px 12px', background: 'rgba(24,95,165,0.05)', border: '0.5px solid rgba(24,95,165,0.18)', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--primary)' }}>
                {fit.type === 'one-page' ? '1 page' : '2 pages'}
              </span>
              {/* Fill bar */}
              <div style={{ flex: 1, height: 5, background: 'rgba(79,70,229,0.12)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: 3, transition: 'width 0.4s ease',
                  background: 'var(--primary)',
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
  const { t } = useI18n()
  const available = ADDABLE_SECTIONS.filter(s => !sectionOrder.includes(s.id))
  return (
    <div style={{ position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)', marginBottom: 6, background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 8, boxShadow: '0 4px 20px rgba(0,0,0,0.12)', zIndex: 50, minWidth: 180, overflow: 'hidden' }}>
      <div style={{ padding: '6px 10px', fontSize: 9, fontWeight: 600, color: 'var(--text-muted)', borderBottom: '0.5px solid var(--border)' }}>{t('resume.addSection')}</div>
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
          style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 12px', fontSize: 12, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer' }}
          onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-secondary)')}
          onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.background = 'none')}>
          {t('resume.customSection')}
        </button>
      </div>
    </div>
  )
}

// ── ResumeLibraryPanel ────────────────────────────────────────────────────────

function ResumeLibraryPanel({
  resumes,
  directions,
  selectedId,
  onSelect,
  onRename,
  onDelete,
  onSetDefault,
  onUnlink,
}: {
  resumes:    ResumeListItem[]
  directions: Direction[]
  selectedId: string | null
  onSelect:   (id: string) => void
  onRename: (resume: ResumeListItem) => void
  onDelete: (resume: ResumeListItem) => void
  onSetDefault: (resume: ResumeListItem) => void
  onUnlink: (resume: ResumeListItem) => void
}) {
  const { t } = useI18n()
  const [openPopoverId, setOpenPopoverId] = useState<string | null>(null)
  const [popoverJobs,   setPopoverJobs]   = useState<Array<{ id: string; company: string; role: string }>>([])
  const [loadingPop,    setLoadingPop]    = useState(false)
  const [openMenuId,    setOpenMenuId]    = useState<string | null>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpenPopoverId(null)
      }
    }
    if (openPopoverId) {
      document.addEventListener('mousedown', handleMouseDown)
    }
    return () => { document.removeEventListener('mousedown', handleMouseDown) }
  }, [openPopoverId])

  async function openUsedByPopover(resumeId: string) {
    if (openPopoverId === resumeId) { setOpenPopoverId(null); return }
    setOpenPopoverId(resumeId)
    setLoadingPop(true)
    try {
      const res  = await fetch(`/api/jobs?finalResumeId=${resumeId}&pageSize=20`)
      if (!res.ok) throw new Error('Failed to fetch jobs')
      const data = await res.json()
      setPopoverJobs(Array.isArray(data.jobs) ? data.jobs : [])
    } catch { setPopoverJobs([]) }
    finally { setLoadingPop(false) }
  }

  if (resumes.length === 0) return (
    <div style={{ padding: '10px 0', fontSize: 12, color: 'var(--text-muted)' }}>
      {t('resume.noResumesDirection')}
    </div>
  )

  return (
    <div className="resume-library-list">
      {resumes.map(r => {
        const dir = directions.find(d => d.id === r.directionId)
        const jobCount = r._count?.finalForJobs ?? 0
        const isSelected = r.id === selectedId
        return (
          <div key={r.id}
            className={`resume-library-item${isSelected ? ' is-selected' : ''}`}
            onClick={() => onSelect(r.id)}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 10px',
              borderRadius: 7, cursor: 'pointer',
              background: isSelected ? 'rgba(79,70,229,0.08)' : 'var(--bg)',
              border: `0.5px solid ${isSelected ? 'var(--primary)' : 'var(--border)'}`,
              transition: 'border-color 0.15s',
            }}>
            <span className="resume-library-file-icon"><FileText size={18} strokeWidth={1.7} /></span>

            {/* Name + direction */}
            <div className="resume-library-item-copy" style={{ flex: 1, minWidth: 0 }}>
              <div className="resume-library-item-name" style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)' }}>
                {r.name}
              </div>
              {dir && <div className="resume-library-item-detail">{dir.name}</div>}
              {jobCount > 0 && <div ref={openPopoverId === r.id ? popoverRef : undefined} className="resume-library-item-detail is-link" onClick={e => { e.stopPropagation(); openUsedByPopover(r.id) }}>
                {t('resume.linkedSavedJob')} ({jobCount})
                {openPopoverId === r.id && <div className="resume-library-lineage-popover">
                  <div style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6 }}>{t('resume.usedBySavedJobs')}</div>
                  {loadingPop ? <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('common.loading')}</div> : popoverJobs.length === 0 ? <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('resume.noJobsFound')}</div> : popoverJobs.map(j => <div key={j.id} style={{ fontSize: 11, padding: '3px 0', color: 'var(--text)', borderBottom: '0.5px solid var(--border)' }}>{j.company} · {j.role}</div>)}
                </div>}
              </div>}
              <div className="resume-library-item-meta">{t('resume.lastEdited')}: {fmtDate(r.updatedAt)}</div>
              <div className="resume-library-item-badges" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                {r.origin === 'upload' && <span className="resume-tag base">{t('resume.base')}</span>}
                {r.kind === 'adapted' && <span className="resume-tag tailored">{t('resume.tailored')}</span>}
                {jobCount > 0 && <span className="resume-tag final">{t('resume.final')}</span>}
                {r.isDefault && <span className="resume-tag default">{t('resume.default')}</span>}
              </div>
            </div>
            <div className="resume-library-more" onClick={e => e.stopPropagation()}>
              <button type="button" aria-label={`More actions for ${r.name}`} onClick={() => setOpenMenuId(value => value === r.id ? null : r.id)}>⋮</button>
              {openMenuId === r.id && <div role="menu" className="resume-library-item-menu">
                {!r.isDefault && <button type="button" onClick={() => { setOpenMenuId(null); onSetDefault(r) }}>{t('resume.setDefault')}</button>}
                <button type="button" onClick={() => { setOpenMenuId(null); onRename(r) }}>{t('resume.rename')}</button>
                {(r.targetJobId || jobCount > 0) && <button type="button" onClick={() => { setOpenMenuId(null); onUnlink(r) }}>{t('resume.cancelLink')}</button>}
                <button type="button" className="danger" onClick={() => { setOpenMenuId(null); onDelete(r) }}>{t('resume.delete')}</button>
              </div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── ResumePage ────────────────────────────────────────────────────────────────

interface ResumePageProps {
  sidebarCollapsed?: boolean
  onToggleSidebar?: () => void
}

export function ResumePage({ sidebarCollapsed = false, onToggleSidebar }: ResumePageProps) {
  const { navigate, registerNavigationGuard, publishRecoveryDraft } = useNav()
  const { data: resumeSession, status: resumeSessionStatus } = useSession()
  const resumeUserIdRef = useRef<string | null>(null)
  const resumeUserId = resumeSessionStatus === 'authenticated' ? resumeSession?.user?.id ?? null : null
  resumeUserIdRef.current = resumeUserId
  const [returnToJobs] = useState(() => new URLSearchParams(window.location.search).get('returnToJobs') === '1')
  const [returnJobId] = useState(() => new URLSearchParams(window.location.search).get('returnJobId'))
  const [returnResumeId] = useState(() => new URLSearchParams(window.location.search).get('resumeId'))
  const toast = useToast()
  const [confirm, ConfirmDialog] = useConfirm()
  const { t } = useI18n()
  const sidebarCollapsedRef = useRef(sidebarCollapsed)
  const sidebarCollapseTimer = useRef<number | null>(null)

  const { data: resumeList, loading: loadingList } = useApi<ResumeListItem[]>('/api/resume')
  const [resumes,          setResumes]          = useState<ResumeListItem[]>([])
  const [selectedResumeId, setSelectedResumeIdState] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('resumeId'),
  )
  const selectedResumeIdRef = useRef(selectedResumeId)
  const resumeSelectionAttempt = useRef(0)
  function setSelectedResumeId(id: string | null) {
    selectedResumeIdRef.current = id
    setSelectedResumeIdState(id)
  }
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('resumeId')
    if (requested) setSelectedResumeId(requested)
  }, [])
  const [libraryCollapsed, setLibraryCollapsed] = useState(false)
  const [libraryCollapsing, setLibraryCollapsing] = useState(false)
  const [libraryWidth, setLibraryWidth] = useState(RESUME_LIBRARY_DEFAULT_WIDTH)
  const [libraryResizing, setLibraryResizing] = useState(false)
  const libraryCollapseAnimationTimer = useRef<number | null>(null)
  const libraryResizeStart = useRef<{
    pointerId: number
    startX: number
    startWidth: number
    wasCollapsed: boolean
    sidebarToggleSent: boolean
    libraryCollapseStaged: boolean
  } | null>(null)
  const [aiPanelWidth, setAiPanelWidth] = useState(AI_PANEL_DEFAULT_WIDTH)
  const [aiPanelResizing, setAiPanelResizing] = useState(false)
  const aiPanelResizeStart = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    sidebarCollapsedRef.current = sidebarCollapsed
  }, [sidebarCollapsed])

  useEffect(() => () => {
    if (sidebarCollapseTimer.current !== null) window.clearTimeout(sidebarCollapseTimer.current)
    if (libraryCollapseAnimationTimer.current !== null) window.clearTimeout(libraryCollapseAnimationTimer.current)
  }, [])

  const { data: directionList, refetch: refetchDirections } = useApi<Direction[]>('/api/directions')
  const [directions,       setDirections]       = useState<Direction[]>([])
  const [selectedDirId,    setSelectedDirId]    = useState<string | null>(null)
  const [showAddDirection, setShowAddDirection] = useState(false)
  const [editingDirId,     setEditingDirId]     = useState<string | null>(null)

  const [content,         setContent]         = useState<ResumeContent | null>(null)
  const [contentResumeId, setContentResumeId] = useState<string | null>(null)
  const [contentRevision, setContentRevisionState] = useState<string | null>(null)
  const contentRevisionRef = useRef(contentRevision)
  const setContentRevision = (revision: string | null) => {
    contentRevisionRef.current = revision
    setContentRevisionState(revision)
  }
  const [contentValidated, setContentValidated] = useState(false)
  const [resumeChanges,   setResumeChanges] = useState<ResumeChange[]>([])
  const [resumeName,      setResumeName]      = useState('My Resume')
  const [templateId,      setTemplateId]      = useState('clean')
  const [templateOptions, setTemplateOptions] = useState<TemplateOptions>({})
  const [exportingPdf,    setExportingPdf]    = useState(false)
  const [previewMode,     setPreviewMode]     = useState(false)
  const [rightPanel,      setRightPanel]      = useState<'insights' | 'persona'>('insights')
  const [loadingCont,     setLoadingCont]     = useState(false)
  const [saving,      setSaving]      = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)

  useEffect(() => {
    const timer = window.setInterval(() => setLastSavedAt(value => value ? new Date(value) : value), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const [dirty,       setDirtyState]  = useState(false)
  const dirtyRef = useRef(dirty)
  const editRevisionRef = useRef(0)
  const saveGenerationRef = useRef(0)
  const setDirty = (value: boolean) => {
    dirtyRef.current = value
    if (value) editRevisionRef.current += 1
    if (value) publishCurrentRecovery()
    setDirtyState(value)
  }
  const [editSection, setEditSection] = useState<string | null>(null)

  const { data: jobData } = useApi<{ jobs: Job[] }>('/api/jobs?pageSize=30')
  const [jobs,          setJobs]          = useState<Job[]>([])

  const [selectedJobId, setSelectedJobIdState] = useState<string | null>(null)
  const selectedJobIdRef = useRef(selectedJobId)
  const setSelectedJobId = (id: string | null) => {
    selectedJobIdRef.current = id
    setSelectedJobIdState(id)
  }
  const selectedResumeUpdatedAt = resumes.find(resume => resume.id === selectedResumeId)?.updatedAt ?? null
  const [scoreResult, setScoreResult] = useState<ScoreResult | null>(null)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [scoring,     setScoring]     = useState(false)
  const [suggesting,  setSuggesting]  = useState(false)
  const [regeneratingSection, setRegeneratingSection] = useState<AiSuggestionSection | null>(null)
  // Tracks the resume/job pair the current analysis belongs to. A save changes
  // resume.updatedAt, but it must not discard the visible result or trigger a
  // new model request. Re-analysis is explicit through the AiPanel action.
  const analysisTargetRef = useRef<string | null>(null)
  const analysisRevisionRef = useRef<string | null>(null)
  const analysisSelectionRef = useRef<string | null>(null)
  const automaticAnalysisAttemptRef = useRef<string | null>(null)
  const analysisRequestPool = useRef(createApplicationAnalysisRequestPool<[
    PromiseSettledResult<{ data: ScoreResult | null; error: string | null }>,
    PromiseSettledResult<{ data: { suggestions: Suggestion[] } | null; error: string | null }>,
  ]>(result => result[0].status === 'fulfilled' && Boolean(result[0].value.data)
    && result[1].status === 'fulfilled' && Boolean(result[1].value.data)))
  // True only on the very first resume load (initial mount / tab-remount).
  // Prevents the selectedResumeId effect from wiping cached analysis on remount.
  const isFirstResumeLoad = useRef(true)
  const loadedResumeContextRef = useRef<{ userId: string; resumeId: string } | null>(null)
  // True when resume content has changed since the last completed analysis.
  // Drives the "Resume updated — re-analyze?" banner in AiPanel.
  const [contentChangedSinceAnalysis, setContentChangedSinceAnalysis] = useState(false)
  // Monotonically increasing counter — incremented on each runAnalysis call.
  // Responses from superseded calls are silently discarded (race-condition guard).
  const analysisEpochRef = useRef(0)
  const [latestApplicationAudit, setLatestApplicationAudit] = useState<StoredApplicationAudit | null>(null)
  const [invalidatedAudit, setInvalidatedAudit] = useState<ApplicationAuditIdentity | null>(null)
  const [auditingApplication, setAuditingApplication] = useState(false)
  const [applyingAuditFinding, setApplyingAuditFinding] = useState<number | null>(null)
  const [auditError, setAuditError] = useState<string | null>(null)
  const auditRunRef = useRef(false)
  const applyingAuditRef = useRef(false)
  const correctionConflictRef = useRef(false)
  const versionRestoreIntentRef = useRef(false)
  const versionRestoreUnknownRef = useRef(false)
  const [latestSavedCoverLetter, setLatestSavedCoverLetter] = useState<CoverLetter | null>(null)

  const [showTemplates,   setShowTemplates]   = useState(false)
  const [showCoverLetter, setShowCoverLetter] = useState(false)
  const [showFinalConfirm, setShowFinalConfirm] = useState(false)
  const [exportedPackFolder, setExportedPackFolder] = useState<string | null>(null)
  const [showNewResume,   setShowNewResume]   = useState(false)
  const [renamingResume,  setRenamingResume]  = useState<ResumeListItem | null>(null)
  const [showUploadModal,   setShowUploadModal]   = useState(false)
  const [showIntakeDialog,  setShowIntakeDialog]  = useState(false)
  const [intakeFile,        setIntakeFile]        = useState<File | null>(null)
  const [libraryImportDragOver, setLibraryImportDragOver] = useState(false)
  const [creatingResume,  setCreatingResume]  = useState(false)
  const [showAddSection,  setShowAddSection]  = useState(false)
  const [showVersions,    setShowVersions]    = useState(false)
  const [versions,        setVersions]        = useState<Array<{ id: string; name: string; createdAt: string }>>([])
  const [loadingVers,     setLoadingVers]     = useState(false)
  const [restoring,       setRestoring]       = useState(false)

  useEffect(() => {
    try {
      const storedValue = window.localStorage.getItem(AI_PANEL_WIDTH_STORAGE_KEY)
      const storedWidth = storedValue === null ? NaN : Number(storedValue)
      if (Number.isFinite(storedWidth)) {
        const migratedWidth = storedWidth === AI_PANEL_LEGACY_DEFAULT_WIDTH ? AI_PANEL_DEFAULT_WIDTH : storedWidth
        setAiPanelWidth(Math.min(AI_PANEL_MAX_WIDTH, Math.max(AI_PANEL_MIN_WIDTH, migratedWidth)))
      }
    } catch { /* localStorage may be unavailable in private browsing */ }
  }, [])

  useEffect(() => {
    try { window.localStorage.setItem(AI_PANEL_WIDTH_STORAGE_KEY, String(aiPanelWidth)) } catch { /* ignore storage failures */ }
  }, [aiPanelWidth])

  useEffect(() => {
    if (!aiPanelResizing && !libraryResizing) return
    const previousUserSelect = document.body.style.userSelect
    const previousCursor = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    return () => {
      document.body.style.userSelect = previousUserSelect
      document.body.style.cursor = previousCursor
    }
  }, [aiPanelResizing, libraryResizing])

  function updateAiPanelWidth(clientX: number) {
    const start = aiPanelResizeStart.current
    if (!start) return
    const nextWidth = start.startWidth + start.startX - clientX
    setAiPanelWidth(Math.min(AI_PANEL_MAX_WIDTH, Math.max(AI_PANEL_MIN_WIDTH, nextWidth)))
  }

  function handleAiPanelResizeStart(event: React.PointerEvent<HTMLDivElement>) {
    if (window.matchMedia('(max-width: 960px)').matches) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    aiPanelResizeStart.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: aiPanelWidth }
    setAiPanelResizing(true)
  }

  function handleAiPanelResizeMove(event: React.PointerEvent<HTMLDivElement>) {
    if (aiPanelResizeStart.current?.pointerId !== event.pointerId) return
    updateAiPanelWidth(event.clientX)
  }

  function handleAiPanelResizeEnd(event: React.PointerEvent<HTMLDivElement>) {
    if (aiPanelResizeStart.current?.pointerId !== event.pointerId) return
    aiPanelResizeStart.current = null
    setAiPanelResizing(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function handleAiPanelResizeKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 40 : 16
    const current = aiPanelWidth
    const nextWidth = event.key === 'ArrowLeft'
      ? current + step
      : event.key === 'ArrowRight'
        ? current - step
        : event.key === 'Home'
          ? AI_PANEL_MIN_WIDTH
          : event.key === 'End'
            ? AI_PANEL_MAX_WIDTH
            : null
    if (nextWidth === null) return
    event.preventDefault()
    setAiPanelWidth(Math.min(AI_PANEL_MAX_WIDTH, Math.max(AI_PANEL_MIN_WIDTH, nextWidth)))
  }

  function clampLibraryWidth(width: number) {
    return Math.min(RESUME_LIBRARY_MAX_WIDTH, Math.max(RESUME_LIBRARY_MIN_WIDTH, width))
  }

  function cancelPendingSidebarCollapse(start: NonNullable<typeof libraryResizeStart.current>) {
    if (sidebarCollapseTimer.current !== null) {
      window.clearTimeout(sidebarCollapseTimer.current)
      sidebarCollapseTimer.current = null
    }
    start.sidebarToggleSent = false
  }

  function cancelLibraryCollapseAnimation(start: NonNullable<typeof libraryResizeStart.current>) {
    if (libraryCollapseAnimationTimer.current !== null) {
      window.clearTimeout(libraryCollapseAnimationTimer.current)
      libraryCollapseAnimationTimer.current = null
    }
    start.libraryCollapseStaged = false
    setLibraryCollapsing(false)
  }

  function stageLibraryCollapse(start: NonNullable<typeof libraryResizeStart.current>) {
    if (start.libraryCollapseStaged) return
    start.libraryCollapseStaged = true
    setLibraryCollapsed(true)
    setLibraryCollapsing(true)
    libraryCollapseAnimationTimer.current = window.setTimeout(() => {
      libraryCollapseAnimationTimer.current = null
      setLibraryCollapsing(false)
    }, RESUME_LIBRARY_COLLAPSE_ANIMATION_MS)
  }

  function scheduleSidebarCollapse(start: NonNullable<typeof libraryResizeStart.current>) {
    if (sidebarCollapsedRef.current || start.sidebarToggleSent || !onToggleSidebar) return
    start.sidebarToggleSent = true
    sidebarCollapseTimer.current = window.setTimeout(() => {
      sidebarCollapseTimer.current = null
      if (!sidebarCollapsedRef.current) onToggleSidebar()
    }, MAIN_NAV_COLLAPSE_DELAY_MS)
  }

  function updateLibraryWidth(clientX: number) {
    const start = libraryResizeStart.current
    if (!start) return
    const deltaX = clientX - start.startX
    const dragLeft = Math.max(0, -deltaX)

    if (start.wasCollapsed) {
      if (deltaX >= 28) {
        cancelPendingSidebarCollapse(start)
        cancelLibraryCollapseAnimation(start)
        setLibraryCollapsed(false)
        setLibraryWidth(clampLibraryWidth(RESUME_LIBRARY_DEFAULT_WIDTH + deltaX))
      } else if (dragLeft >= MAIN_NAV_COLLAPSE_DRAG_DISTANCE) {
        scheduleSidebarCollapse(start)
      }
      return
    }

    const nextWidth = start.startWidth + deltaX
    if (nextWidth <= RESUME_LIBRARY_COLLAPSE_THRESHOLD) {
      stageLibraryCollapse(start)
      if (dragLeft >= start.startWidth - RESUME_LIBRARY_COLLAPSE_THRESHOLD + MAIN_NAV_COLLAPSE_DRAG_DISTANCE) {
        scheduleSidebarCollapse(start)
      }
      return
    }

    cancelPendingSidebarCollapse(start)
    cancelLibraryCollapseAnimation(start)
    setLibraryCollapsed(false)
    setLibraryWidth(clampLibraryWidth(nextWidth))
  }

  function handleLibraryResizeStart(event: React.PointerEvent<HTMLDivElement>) {
    if (window.matchMedia('(max-width: 960px)').matches) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    libraryResizeStart.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: libraryCollapsed ? RESUME_LIBRARY_COLLAPSED_WIDTH : libraryWidth,
      wasCollapsed: libraryCollapsed,
      sidebarToggleSent: false,
      libraryCollapseStaged: false,
    }
    setLibraryResizing(true)
  }

  function handleLibraryResizeMove(event: React.PointerEvent<HTMLDivElement>) {
    if (libraryResizeStart.current?.pointerId !== event.pointerId) return
    updateLibraryWidth(event.clientX)
  }

  function handleLibraryResizeEnd(event: React.PointerEvent<HTMLDivElement>) {
    if (libraryResizeStart.current?.pointerId !== event.pointerId) return
    const start = libraryResizeStart.current
    if (event.type === 'pointercancel') {
      cancelPendingSidebarCollapse(start)
      cancelLibraryCollapseAnimation(start)
    }
    libraryResizeStart.current = null
    setLibraryResizing(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function handleLibraryResizeKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 40 : 16
    const current = libraryCollapsed ? RESUME_LIBRARY_COLLAPSED_WIDTH : libraryWidth
    const nextWidth = event.key === 'ArrowLeft'
      ? current - step
      : event.key === 'ArrowRight'
        ? current + step
        : event.key === 'Home'
          ? RESUME_LIBRARY_COLLAPSED_WIDTH
          : event.key === 'End'
            ? RESUME_LIBRARY_MAX_WIDTH
            : null
    if (nextWidth === null) return
    event.preventDefault()
    if (nextWidth <= RESUME_LIBRARY_COLLAPSE_THRESHOLD) {
      setLibraryCollapsed(true)
      return
    }
    setLibraryCollapsed(false)
    setLibraryWidth(clampLibraryWidth(nextWidth))
  }

  // Section ordering
  const [sectionOrder,    setSectionOrder]    = useState<string[]>(DEFAULT_ORDER)
  const sectionDragRef = useRef<number | null>(null)
  const [sectionDragOver, setSectionDragOver] = useState<number | null>(null)

  const initDone = useRef(false)
  const requestedResumeIdRef = useRef<string | null>(null)

  useEffect(() => {
    let returnContext: { resumeId?: string } | null = null
    try { returnContext = JSON.parse(sessionStorage.getItem('applymate:resume-return') ?? 'null') as { resumeId?: string } | null } catch { /* ignore malformed return context */ }
    requestedResumeIdRef.current = new URLSearchParams(window.location.search).get('resumeId') ?? returnContext?.resumeId ?? null
  }, [])

  useEffect(() => {
    if (!resumeList) return
    setResumes(resumeList)
    if (resumeList.length > 0) {
      const requestedResumeId = requestedResumeIdRef.current
      const requestedResume = requestedResumeId ? resumeList.find(resume => resume.id === requestedResumeId) : null
      if (requestedResume) {
        void selectResume(requestedResume.id, requestedResume).then(selected => {
          if (selected) {
            requestedResumeIdRef.current = null
            sessionStorage.removeItem('applymate:resume-return')
          }
        })
      } else if (!requestedResumeId && !selectedResumeId) {
        const def = resumeList.find(r => r.isDefault) ?? resumeList[0]
        setSelectedResumeId(def.id)
      }
    }
  }, [resumeList])

  useEffect(() => {
    if (directionList) setDirections(directionList)
  }, [directionList])

  useEffect(() => {
    if (loadingList || initDone.current) return
    if (!resumeList) return
    initDone.current = true
    if (resumeList.length === 0) {
      apiMutate<Resume>('/api/resume', 'POST', {
        name: 'My Resume', content: EMPTY_CONTENT, isDefault: true,
      }).then(({ data, error }) => {
        if (data) {
          setResumes([{ id: data.id, name: data.name, isDefault: data.isDefault, directionId: null, kind: 'base' as const, parentResumeId: null, targetJobId: null, origin: 'manual' as const, basicsDetached: false, createdAt: data.createdAt, updatedAt: data.updatedAt }])
          setSelectedResumeId(data.id)
          setContent(EMPTY_CONTENT)
          setResumeName(data.name)
          toast.info('Resume created', 'Fill in your details to get started')
        } else toast.error('Error', error ?? 'Could not create resume')
      })
    }
  }, [resumeList, loadingList])

  useEffect(() => {
    if (!selectedResumeId || !resumeUserId) return
    const controller = new AbortController()
    const resumeUrl = `/api/resume/${selectedResumeId}`
    const requestUserId = resumeUserIdRef.current
    const requestEditRevision = editRevisionRef.current
    const requestSaveGeneration = saveGenerationRef.current
    const previousContext = loadedResumeContextRef.current
    const sameContext = previousContext?.userId === resumeUserId && previousContext.resumeId === selectedResumeId
    setResumeChanges([])
    const applyResume = (resume: Resume) => {
      const c = (resume.content ?? EMPTY_CONTENT) as ResumeContent
      if (sameContext && contentRevisionRef.current && resume.updatedAt !== contentRevisionRef.current) {
        analysisEpochRef.current += 1
        setScoring(false)
        setSuggesting(false)
        setContentChangedSinceAnalysis(true)
      }
      setContent(c)
      setContentResumeId(selectedResumeId)
      setContentRevision(resume.updatedAt ?? null)
      setResumeName(resume.name)
      setTemplateId(resume.templateId ?? 'clean')
      setTemplateOptions((resume.templateOptions ?? {}) as TemplateOptions)
      setSectionOrder(c.sectionOrder ?? DEFAULT_ORDER)
    }
    const cachedResume = getCachedApiResponse<Resume>(resumeUrl, requestUserId)
    const preserveEdits = sameContext && (dirtyRef.current || isSavingRef.current)
    loadedResumeContextRef.current = { userId: resumeUserId, resumeId: selectedResumeId }
    if (!preserveEdits) setContentResumeId(null)
    setContentValidated(false)
    setLoadingCont(true)
    if (!preserveEdits) {
      setDirty(false)
      if (!sameContext) setContentChangedSinceAnalysis(false)
    }
    if (!isFirstResumeLoad.current && !sameContext) {
      // User actively switched to a different resume — clear stale analysis
      setScoreResult(null); setSuggestions([])
      analysisTargetRef.current = null
    }
    isFirstResumeLoad.current = false
    if (cachedResume && !preserveEdits) {
      applyResume(cachedResume)
      setLoadingCont(false)
    }
    fetch(resumeUrl, { signal: controller.signal })
      .then(async response => {
        const resume = await response.json() as Resume
        if (!response.ok) throw new Error('Could not load resume')
        return resume
      })
      .then(resume => {
        if (!mayApplyResumeRevalidation({
          resumeId: selectedResumeId,
          currentResumeId: selectedResumeIdRef.current,
          userId: requestUserId,
          currentUserId: resumeUserIdRef.current,
          editRevision: requestEditRevision,
          currentEditRevision: editRevisionRef.current,
          saveGeneration: requestSaveGeneration,
          currentSaveGeneration: saveGenerationRef.current,
          aborted: controller.signal.aborted || !mountedRef.current,
        })) return
        // A cached resume becomes editable immediately. Do not let a delayed
        // revalidation response overwrite edits made before it returns.
        if (dirtyRef.current || isSavingRef.current) return
        setCachedApiResponse(resumeUrl, resume, requestUserId)
        applyResume(resume)
      })
      .catch(error => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        if (cachedResume) {
          toast.warning(t('resume.cachedVersionTitle'), t('resume.cachedVersionDetail'))
          return
        }
        toast.error('Error', 'Could not load resume')
      })
      .finally(() => { if (!controller.signal.aborted) { setLoadingCont(false); setContentValidated(true) } })
    return () => controller.abort()
  }, [selectedResumeId, resumeUserId])

  useEffect(() => { if (jobData?.jobs) setJobs(jobData.jobs) }, [jobData])

  useEffect(() => {
    if (!selectedResumeId || jobs.length === 0) return
    const resume = resumes.find(item => item.id === selectedResumeId)
    const linkedJobId = resume?.targetJobId ?? jobs.find(job => job.finalResumeId === selectedResumeId)?.id ?? null
    if (linkedJobId) setSelectedJobId(linkedJobId)
  }, [jobs, resumes, selectedResumeId])

  useEffect(() => {
    const targetKey = analysisTargetKey(selectedResumeId, selectedJobId)
    if (analysisSelectionRef.current !== targetKey) {
      analysisSelectionRef.current = targetKey
      automaticAnalysisAttemptRef.current = null
      analysisRevisionRef.current = null
      analysisEpochRef.current += 1
      setScoring(false)
      setSuggesting(false)
    }
    if (!contentValidated || contentResumeId !== selectedResumeId) return
    const cached = getAnalysisCache(selectedResumeId, selectedJobId, contentRevision)
    if (cached) {
      setScoreResult(cached.score)
      setSuggestions(cached.suggs)
      analysisTargetRef.current = targetKey
      analysisRevisionRef.current = contentRevision
      return
    }
    // Saving an edit changes updatedAt and invalidates the persisted cache, but
    // the current in-memory result remains useful until the user re-analyzes.
    if (shouldPreserveAnalysis(analysisTargetRef.current, targetKey)) return
    setScoreResult(null)
    setSuggestions([])
    analysisTargetRef.current = null
  }, [selectedJobId, selectedResumeId, contentRevision, contentResumeId, contentValidated])

  useEffect(() => {
    if (!selectedJobId || !content || !contentValidated || contentResumeId !== selectedResumeId || jobs.length === 0) return
    // Skip if we already have analysis results for this exact job (e.g. restored from
    // cache after tab navigation). The user can still force a re-run via the ↻ button.
    const cached = getAnalysisCache(selectedResumeId, selectedJobId, contentRevision)
    if (cached) {
      const targetKey = analysisTargetKey(selectedResumeId, selectedJobId)
      if (analysisTargetRef.current !== targetKey) {
        setScoreResult(cached.score)
        setSuggestions(cached.suggs)
        analysisTargetRef.current = targetKey
        analysisRevisionRef.current = contentRevision
      }
      return
    }
    // Edits intentionally leave the existing suggestions visible. The stale
    // banner offers the user an explicit re-analysis action, avoiding a
    // save -> analyze -> replace-the-panel loop and unnecessary token usage.
    const targetKey = analysisTargetKey(selectedResumeId, selectedJobId)
    if (!targetKey || regeneratingSection || automaticAnalysisAttemptRef.current === targetKey || !jobs.some(job => job.id === selectedJobId)) return
    if (!shouldStartAutomaticAnalysis({
      targetKey,
      activeTargetKey: analysisTargetRef.current,
      hasScore: Boolean(scoreResult),
      hasContent: Boolean(content),
      hasJobs: jobs.length > 0,
      contentChangedSinceAnalysis,
    })) return
    automaticAnalysisAttemptRef.current = targetKey
    void runAnalysis(content, selectedJobId, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJobId, selectedResumeId, contentRevision, contentResumeId, contentValidated, jobs, content, contentChangedSinceAnalysis, regeneratingSection])

  const [flashField, setFlashField] = useState('')

  function currentResumeSectionValue(section: ResumeChangeSection, sourceContent: ResumeContent | null = content) {
    if (!sourceContent || section === 'cover_letter') return undefined
    return sourceContent[section as keyof ResumeContent]
  }

  function recordResumeChange(source: ResumeChangeSource, section: ResumeChangeSection, before: unknown, after: unknown) {
    const beforeText = formatResumeChangeValue(section, before)
    const afterText = formatResumeChangeValue(section, after)
    if (beforeText === afterText) return
    const change: ResumeChange = {
      id: `${source}-${section}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source,
      section,
      before: beforeText,
      after: afterText,
      createdAt: Date.now(),
    }
    setResumeChanges(previous => [change, ...previous].slice(0, 8))
    window.requestAnimationFrame(() => document.querySelector('[data-resume-change-summary]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
  }

  function dismissResumeChange(id: string) {
    setResumeChanges(previous => previous.filter(change => change.id !== id))
  }

  function renderSectionChangeMarker(section: ResumeChangeSection) {
    const changes = resumeChanges.filter(change => change.section === section)
    if (!changes.length) return null
    const sources = [...new Set(changes.map(change => change.source))]
      .map(source => source === 'audit' ? t('resume.changeSourceAudit') : t('resume.changeSourceAi'))
      .join(' + ')
    return <div className="resume-editor-section-change-label">{sources} · {changes.length} {t('resume.changeAppliedLabel')}</div>
  }

  function triggerFlash(fieldKey: string) {
    setFlashField(fieldKey)
    setTimeout(() => setFlashField(''), 2200)
  }

  function patch(updater: (prev: ResumeContent) => ResumeContent, fieldKey?: string) {
    const prev = latestContent.current
    if (!prev) return
    const next = updater(prev)
    latestContent.current = next
    setContent(next)
    setDirty(true)
    setContentChangedSinceAnalysis(true)
    if (fieldKey) triggerFlash(fieldKey)
  }

  function applyFormat([prefix, suffix]: [string, string]) {
    const el = document.activeElement
    if (!el || !(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) {
      toast.info('Click into a text field first', 'Select text in any section to format it'); return
    }
    const start = el.selectionStart ?? 0; const end = el.selectionEnd ?? 0
    let nextValue = el.value
    let nextStart = start
    let nextEnd = end
    if (start === end) {
      if (prefix === '# ' || prefix === '## ' || prefix === '• ') {
        const before = el.value.substring(0, start)
        const lineStart = before.lastIndexOf('\n') + 1
        const lineEnd = el.value.indexOf('\n', start)
        const lineContent = el.value.substring(lineStart, lineEnd === -1 ? el.value.length : lineEnd)
        if (lineContent.startsWith(prefix)) {
          nextValue = el.value.substring(0, lineStart) + lineContent.slice(prefix.length) + el.value.substring(lineEnd === -1 ? el.value.length : lineEnd)
          nextStart = nextEnd = start - prefix.length
        } else {
          nextValue = el.value.substring(0, lineStart) + prefix + lineContent + el.value.substring(lineEnd === -1 ? el.value.length : lineEnd)
          nextStart = nextEnd = start + prefix.length
        }
      } else {
        const wrapped = prefix + suffix
        nextValue = el.value.substring(0, start) + wrapped + el.value.substring(end)
        nextStart = nextEnd = start + wrapped.length
      }
    } else {
      const selected = el.value.substring(start, end)
      const wrapped = prefix + selected + suffix
      nextValue = el.value.substring(0, start) + wrapped + el.value.substring(end)
      nextStart = start; nextEnd = start + wrapped.length
    }
    const prototype = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    if (setter) { setter.call(el, nextValue); el.dispatchEvent(new Event('input', { bubbles: true })) }
    else el.value = nextValue
    el.selectionStart = nextStart; el.selectionEnd = nextEnd
    el.focus(); setDirty(true)
  }

  async function runAnalysis(c: ResumeContent, jobId: string, automatic = false) {
    if (regeneratingSection || !contentValidated || contentResumeId !== selectedResumeId) return
    const requestUserId = resumeUserIdRef.current
    if (!requestUserId || !selectedResumeId) return
    const job = jobs.find(j => j.id === jobId); if (!job) return
    // Epoch guard: if a newer analysis starts before this one finishes, discard this result
    const epoch = ++analysisEpochRef.current
    const editRevision = editRevisionRef.current
    const analyzedRevision = contentRevision
    const wasDirty = dirtyRef.current
    setScoring(true); setSuggesting(true)
    const start = () => Promise.allSettled([
      apiMutate<ScoreResult>('/api/ai/score', 'POST', { resumeContent: c, jobTitle: job.role, jobCompany: job.company, jobDescription: job.description ?? undefined }),
      apiMutate<{ suggestions: Suggestion[] }>('/api/ai/suggest', 'POST', { resumeContent: c, jobTitle: job.role, jobCompany: job.company, jobDescription: job.description ?? undefined }),
    ])
    const requestKey = JSON.stringify([requestUserId, selectedResumeId, jobId, analyzedRevision])
    if (!automatic && analyzedRevision) analysisRequestPool.current.forget(requestKey)
    const [scoreRes, suggestRes] = await (automatic && analyzedRevision && !wasDirty ? analysisRequestPool.current(requestKey, start) : start())
    if (!mayApplyApplicationAnalysis({
      mounted: mountedRef.current,
      userId: requestUserId,
      currentUserId: resumeUserIdRef.current,
      resumeId: selectedResumeId,
      currentResumeId: selectedResumeIdRef.current,
      jobId,
      currentJobId: selectedJobIdRef.current,
      revision: analyzedRevision,
      currentRevision: contentRevisionRef.current,
      editRevision,
      currentEditRevision: editRevisionRef.current,
      epoch,
      currentEpoch: analysisEpochRef.current,
    })) {
      if (mountedRef.current && requestUserId === resumeUserIdRef.current && analysisEpochRef.current === epoch) {
        setScoring(false)
        setSuggesting(false)
        if (editRevisionRef.current !== editRevision || contentRevisionRef.current !== analyzedRevision) setContentChangedSinceAnalysis(true)
      }
      return
    }
    setScoring(false); setSuggesting(false)
    if (scoreRes.status === 'fulfilled' && scoreRes.value.data) {
      setScoreResult(scoreRes.value.data)
      analysisTargetRef.current = analysisTargetKey(selectedResumeId, jobId)
      analysisRevisionRef.current = !wasDirty ? analyzedRevision : null
      setContentChangedSinceAnalysis(editRevisionRef.current !== editRevision)
    } else { const msg = scoreRes.status === 'fulfilled' ? (scoreRes.value.error ?? 'Unknown') : scoreRes.reason; toast.error('Analysis failed', typeof msg === 'string' ? msg : 'Check ANTHROPIC_API_KEY') }
    if (suggestRes.status === 'fulfilled' && suggestRes.value.data?.suggestions) {
      setSuggestions(suggestRes.value.data.suggestions)
    }
    // Persist to localStorage — include resumeId so cache is resume-scoped
    if (scoreRes.status === 'fulfilled' && scoreRes.value.data && analyzedRevision && !wasDirty) {
      try {
        const latestJob = jobs.find(j => j.id === selectedJobId)
        saveCache({
          resumeId: selectedResumeId,
          jobId: selectedJobId,
          resumeUpdatedAt: analyzedRevision,
          jobTitle: latestJob?.role ?? '',
          jobCompany: latestJob?.company ?? '',
          score: scoreRes.value.data,
          suggs: suggestRes.status === 'fulfilled' ? (suggestRes.value.data?.suggestions ?? []) : [],
        })
      } catch {}
    }
  }

  async function regenerateSection(section: string) {
    if (!content || !selectedJobId || scoring || suggesting || regeneratingSection) return
    if (!AI_SUGGESTION_SECTIONS.includes(section as AiSuggestionSection)) return
    const targetSection = section as AiSuggestionSection
    const job = jobs.find(item => item.id === selectedJobId)
    if (!job) return

    setRegeneratingSection(targetSection)
    try {
      const { data, error } = await apiMutate<{ suggestions: Suggestion[] }>('/api/ai/suggest', 'POST', {
        resumeContent: content,
        jobTitle: job.role,
        jobCompany: job.company,
        jobDescription: job.description ?? undefined,
        section: targetSection,
      })
      if (error || !data) {
        toast.error(t('resume.sectionRegenerationFailed'), error ?? t('resume.sectionRegenerationFailedDetail'))
        return
      }

      const appliedHistory = suggestions.filter(suggestion => suggestion.target === targetSection && suggestion.applied)
      const freshSuggestions = (data.suggestions ?? []).filter(suggestion => suggestion.target === targetSection)
      const freshTexts = new Set(appliedHistory.map(suggestion => suggestion.text))
      const merged = replaceSectionSuggestions(suggestions, targetSection, [
        ...appliedHistory,
        ...freshSuggestions.filter(suggestion => !freshTexts.has(suggestion.text)),
      ])
      setSuggestions(merged)
      saveCache({
        resumeId: selectedResumeId,
        jobId: selectedJobId,
        resumeUpdatedAt: analysisRevisionRef.current,
        score: scoreResult,
        suggs: merged,
      })
      toast.success(t('resume.sectionRegenerated'), freshSuggestions.length > 0 ? t('resume.sectionRegeneratedDetail') : t('resume.noNewSectionSuggestions'))
    } finally {
      setRegeneratingSection(null)
    }
  }

  // Always-fresh refs so handleSave never reads stale closure values
  const latestContent         = useRef(content)
  const latestSectionOrder    = useRef(sectionOrder)
  const latestTemplateId      = useRef(templateId)
  const latestTemplateOptions = useRef(templateOptions)
  const latestResumeName      = useRef(resumeName)
  const latestSelectedJobId   = useRef(selectedJobId)
  const isSavingRef           = useRef(false)
  const mountedRef            = useRef(true)
  const pendingSaveRef        = useRef(false) // new edits arrived while saving
  const savePromiseRef        = useRef<Promise<boolean> | null>(null)
  const resumeLocationRef     = useRef(typeof window === 'undefined' ? '' : window.location.href)
  if (typeof window !== 'undefined') resumeLocationRef.current = window.location.href
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useLayoutEffect(() => { latestContent.current         = content },         [content])
  useLayoutEffect(() => { latestSectionOrder.current    = sectionOrder },    [sectionOrder])
  useLayoutEffect(() => { latestTemplateId.current      = templateId },      [templateId])
  useLayoutEffect(() => { latestTemplateOptions.current = templateOptions }, [templateOptions])
  useLayoutEffect(() => { latestResumeName.current      = resumeName },      [resumeName])
  useLayoutEffect(() => { latestSelectedJobId.current   = selectedJobId },   [selectedJobId])

  // The shell keeps this snapshot in memory if a session transition unmounts
  // the editor. Never publish the old editor's content under another account.
  const recoveryOwnerRef = useRef(resumeUserId)
  if (!recoveryOwnerRef.current && resumeUserId) recoveryOwnerRef.current = resumeUserId
  function publishCurrentRecovery() {
    const owner = recoveryOwnerRef.current
    const currentContent = latestContent.current
    if (!owner || owner !== resumeUserIdRef.current || !publishRecoveryDraft || !selectedResumeIdRef.current || !currentContent) return
    publishRecoveryDraft(owner, {
      userId: owner, resumeId: selectedResumeIdRef.current, name: latestResumeName.current,
      content: structuredClone(currentContent), sectionOrder: [...latestSectionOrder.current],
      templateId: latestTemplateId.current, templateOptions: structuredClone(latestTemplateOptions.current),
    })
  }
  useLayoutEffect(() => {
    const owner = recoveryOwnerRef.current
    if (!owner || owner !== resumeUserId || !publishRecoveryDraft) return
    if (!dirtyRef.current && !isSavingRef.current) {
      publishRecoveryDraft(owner, null)
      return
    }
    if (!selectedResumeId || !content) return
    publishRecoveryDraft(owner, {
      userId: owner, resumeId: selectedResumeId, name: resumeName,
      content: structuredClone(content), sectionOrder: [...sectionOrder],
      templateId, templateOptions: structuredClone(templateOptions),
    })
  }, [resumeUserId, selectedResumeId, content, sectionOrder, templateId, templateOptions, resumeName, dirty, saving, publishRecoveryDraft])

  function handleSave(): Promise<boolean> {
    if (correctionConflictRef.current) {
      toast.warning(t(versionRestoreUnknownRef.current ? 'resume.restoreUnknownTitle' : 'resume.correctionChangedTitle'),
        t(versionRestoreUnknownRef.current ? 'resume.restoreUnknownDetail' : 'resume.correctionChangedDetail'))
      return Promise.resolve(false)
    }
    if (applyingAuditRef.current) {
      toast.info(t('resume.toastSaving'), t('resume.toastSavingDetail'))
      return Promise.resolve(false)
    }
    if (savePromiseRef.current) return savePromiseRef.current
    const pending = saveResumeChanges(selectedResumeIdRef.current)
    savePromiseRef.current = pending
    void pending.then(
      () => { if (savePromiseRef.current === pending) savePromiseRef.current = null },
      () => { if (savePromiseRef.current === pending) savePromiseRef.current = null },
    )
    return pending
  }

  async function saveResumeChanges(resumeId: string | null, saveUserId = resumeUserIdRef.current): Promise<boolean> {
    if (!resumeId || !saveUserId || saveUserId !== resumeUserIdRef.current || resumeId !== selectedResumeIdRef.current || !latestContent.current) {
      toast.error('Save failed', 'The resume could not be saved. Please try again.')
      return false
    }
    if (isSavingRef.current) { pendingSaveRef.current = true; return false }

    isSavingRef.current = true
    setSaving(true)
    const contentSnapshot = latestContent.current
    const orderSnapshot = latestSectionOrder.current
    const editRevision = editRevisionRef.current
    const snapshot = {
      name:            latestResumeName.current,
      content:         { ...latestContent.current, sectionOrder: latestSectionOrder.current },
      templateId:      latestTemplateId.current,
      templateOptions: latestTemplateOptions.current,
    }
    saveGenerationRef.current += 1
    const { data, error } = await apiMutate<Resume>(`/api/resume/${resumeId}`, 'PATCH', snapshot)
    isSavingRef.current = false
    if (!mountedRef.current) return false
    setSaving(false)
    if (resumeId !== selectedResumeIdRef.current || saveUserId !== resumeUserIdRef.current) return false

    if (error || !data) {
      toast.error('Save failed', error ?? 'No saved resume was returned. Please try again.')
      return false
    } else {
      if (data) {
        setCachedApiResponse(`/api/resume/${resumeId}`, data, saveUserId)
        setContentRevision(data.updatedAt ?? null)
        setResumes(previous => previous.map(resume => resume.id === data.id
          ? { ...resume, name: data.name, updatedAt: data.updatedAt }
          : resume))
      }
      const changedDuringSave = editRevisionRef.current !== editRevision
        || latestContent.current !== contentSnapshot
        || latestSectionOrder.current !== orderSnapshot
        || latestResumeName.current !== snapshot.name
        || latestTemplateId.current !== snapshot.templateId
        || latestTemplateOptions.current !== snapshot.templateOptions
      if (pendingSaveRef.current || changedDuringSave) {
        pendingSaveRef.current = false
        // Await later edits too, so leaving the editor cannot cancel their save.
        await new Promise(resolve => setTimeout(resolve, 0))
        if (!mountedRef.current) return false
        return saveResumeChanges(resumeId, saveUserId)
      }
      dirtyRef.current = false
      setDirty(false)
      setLastSavedAt(new Date())
      toast.success('Saved', 'Resume updated successfully')
      // Re-analysis is intentionally NOT triggered here — the AiPanel stale indicator
      // prompts the user to re-analyse when ready, avoiding a token burn on every save.
      return true
    }
  }

  const saveForNavigationRef = useRef(handleSave)
  saveForNavigationRef.current = handleSave
  useEffect(() => registerNavigationGuard?.({
    needsSave: () => dirtyRef.current || isSavingRef.current || applyingAuditRef.current || versionRestoreIntentRef.current,
    save: async () => {
      if (versionRestoreIntentRef.current) {
        toast.info(t('resume.toastSaving'), t('resume.toastSavingDetail'))
        return false
      }
      const success = await saveForNavigationRef.current()
      return success && !dirtyRef.current && !isSavingRef.current
    },
    currentHref: () => resumeLocationRef.current,
  }), [registerNavigationGuard])
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      guardApplicationUnload(event, dirtyRef.current || isSavingRef.current)
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  // Auto-save: 2 s debounce after any edit
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!dirty) return
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
    autoSaveTimer.current = setTimeout(() => { handleSave() }, 2000)
    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current) }
  }, [content, sectionOrder, templateId, templateOptions, dirty])

  async function handleImportResume(imported: ResumeContent, mode: 'replace' | 'new') {
    if (mode === 'replace' && selectedResumeId) {
      latestContent.current = imported
      latestSectionOrder.current = imported.sectionOrder ?? DEFAULT_ORDER
      setContent(imported)
      setSectionOrder(imported.sectionOrder ?? DEFAULT_ORDER)
      setDirty(true)
      setContentChangedSinceAnalysis(true)
        toast.success(t('resume.toastImported'), t('resume.toastReviewSave'))
    } else {
      // Create a new resume with the imported content
      const name = imported.contact.name ? `${imported.contact.name}'s Resume` : 'Imported Resume'
      setCreatingResume(true)
      const { data, error } = await apiMutate<Resume>('/api/resume', 'POST', { name, content: imported, isDefault: false })
      setCreatingResume(false)
      if (data) {
        const item: ResumeListItem = { id: data.id, name: data.name, isDefault: data.isDefault, directionId: null, kind: 'base' as const, parentResumeId: null, targetJobId: null, origin: 'manual' as const, basicsDetached: false, createdAt: data.createdAt, updatedAt: data.updatedAt }
        setResumes(prev => [...prev, item])
        await selectResume(data.id, item)
        toast.success(t('resume.toastImported'), `"${name}" ${t('resume.toastCreated')}`)
      } else toast.error('Import failed', error ?? 'Could not create resume')
    }
  }

  async function handleCreateResume(name: string) {
    setCreatingResume(true); setShowNewResume(false)
    const { data, error } = await apiMutate<Resume>('/api/resume', 'POST', { name, content: EMPTY_CONTENT, isDefault: false })
    setCreatingResume(false)
    if (data) {
      const item: ResumeListItem = { id: data.id, name: data.name, isDefault: data.isDefault, directionId: null, kind: 'base' as const, parentResumeId: null, targetJobId: null, origin: 'manual' as const, basicsDetached: false, createdAt: data.createdAt, updatedAt: data.updatedAt }
      setResumes(prev => [...prev, item]); await selectResume(data.id, item)
      toast.success('Resume created', `"${name}" is ready to edit`)
    } else toast.error('Error', error ?? 'Could not create resume')
  }

  async function fetchVersions() {
    if (!selectedResumeId) return
    setLoadingVers(true)
    try {
      const res = await fetch(`/api/resume/${selectedResumeId}/versions`)
      const data = await res.json()
      setVersions(Array.isArray(data) ? data : [])
    } catch { setVersions([]) }
    finally { setLoadingVers(false) }
  }

  async function restoreVersion(versionId: string) {
    const requestResumeId = selectedResumeIdRef.current
    const requestUserId = resumeUserIdRef.current
    if (!requestResumeId || !requestUserId || versionRestoreIntentRef.current || applyingAuditRef.current) return
    if (correctionConflictRef.current) {
      toast.warning(t(versionRestoreUnknownRef.current ? 'resume.restoreUnknownTitle' : 'resume.correctionChangedTitle'),
        t(versionRestoreUnknownRef.current ? 'resume.restoreUnknownDetail' : 'resume.correctionChangedDetail'))
      return
    }
    versionRestoreIntentRef.current = true
    setRestoring(true)
    let mutationStarted = false
    try {
      if ((dirtyRef.current || isSavingRef.current) && !(await handleSave())) return
      if (!mountedRef.current || requestUserId !== resumeUserIdRef.current || requestResumeId !== selectedResumeIdRef.current
        || dirtyRef.current || isSavingRef.current || applyingAuditRef.current) return
      const requestEditRevision = editRevisionRef.current
      saveGenerationRef.current += 1
      analysisEpochRef.current += 1
      setScoring(false); setSuggesting(false)
      applyingAuditRef.current = true
      mutationStarted = true
      const { data, error } = await apiMutate<Resume>(`/api/resume/${requestResumeId}/versions`, 'POST', { versionId })
      const disposition = versionRestoreDisposition({
        mounted: mountedRef.current, requestUserId, currentUserId: resumeUserIdRef.current,
        requestResumeId, currentResumeId: selectedResumeIdRef.current,
        requestEditRevision, currentEditRevision: editRevisionRef.current,
        validResponse: !error && !!data && data.id === requestResumeId && !!data.content && typeof data.content === 'object',
      })
      if (disposition === 'ignore') return
      if (disposition === 'unknown') {
        correctionConflictRef.current = true
        versionRestoreUnknownRef.current = true
        toast.warning(t('resume.restoreUnknownTitle'), t('resume.restoreUnknownDetail'))
        return
      }
      if (disposition === 'conflict') {
        correctionConflictRef.current = true
        setContentChangedSinceAnalysis(true)
        toast.warning(t('resume.correctionChangedTitle'), t('resume.correctionChangedDetail'))
        return
      }
      if (!data) return
      latestContent.current = data.content as ResumeContent
      latestSectionOrder.current = data.content.sectionOrder ?? DEFAULT_ORDER
      latestResumeName.current = data.name
      latestTemplateId.current = data.templateId ?? 'clean'
      latestTemplateOptions.current = (data.templateOptions as TemplateOptions) ?? {}
      setContent(data.content as ResumeContent)
      setSectionOrder(data.content.sectionOrder ?? DEFAULT_ORDER)
      setResumeName(data.name)
      setTemplateId(data.templateId ?? 'clean')
      setTemplateOptions((data.templateOptions as TemplateOptions) ?? {})
      setCachedApiResponse(`/api/resume/${requestResumeId}`, data, requestUserId)
      setContentRevision(data.updatedAt ?? null)
      setResumes(previous => previous.map(resume => resume.id === requestResumeId ? { ...resume, name: data.name, updatedAt: data.updatedAt } : resume))
      setShowVersions(false)
      setDirty(false)
      setLastSavedAt(new Date())
      setContentChangedSinceAnalysis(true)
      toast.success(t('resume.restoreSuccessTitle'), t('resume.restoreSuccessDetail'))
    } finally {
      if (mutationStarted) applyingAuditRef.current = false
      versionRestoreIntentRef.current = false
      if (mountedRef.current) setRestoring(false)
    }
  }

  // Apply a keyword/item to the correct section (not just skills)
  function applyTargeted(t: { type: string; section: string; keyword: string; value?: string }) {
    if (!content) return
    const { section, keyword } = t

    switch (section) {
      case 'summary':
        // Append keyword context to summary
        {
          const before = content.summary ?? ''
          const after = before ? `${before} ${keyword}.` : keyword
          recordResumeChange('ai_insights', 'summary', before, after)
          patch(p => ({ ...p, summary: after }), 'summary')
        }
        toast.success('Summary updated', `Added "${keyword}" context`)
        break

      case 'skills':
        {
          const before = content.skills ?? []
          if (before.some(skill => skill.toLowerCase() === keyword.toLowerCase())) {
            toast.info('Already present', `"${keyword}" is already in Skills`)
            break
          }
          const after = [...before, keyword]
          recordResumeChange('ai_insights', 'skills', before, after)
          patch(p => ({ ...p, skills: after }), 'skills')
          toast.success('Skill added', `"${keyword}" added to Skills`)
        }
        break

      case 'experience':
      case 'projects':
        toast.success('Tip noted', `"${keyword}" — add this to your ${section} section`)
        break

      default:
        {
          const before = content.skills ?? []
          if (before.some(skill => skill.toLowerCase() === keyword.toLowerCase())) break
          const after = [...before, keyword]
          recordResumeChange('ai_insights', 'skills', before, after)
          patch(p => ({ ...p, skills: after }), 'skills')
          toast.success('Added', `"${keyword}" added`)
        }
    }
  }

  function applySuggestion(i: number) {
    const s = suggestions[i]
    if (!s || !content) return
    setSuggestions(prev => { const n = [...prev]; n[i] = { ...n[i], applied: true }; return n })

    const hasProposed = s.proposed && s.proposed.trim()

    switch (s.target) {
      case 'summary':
        if (s.action === 'rewrite' && hasProposed) {
          recordResumeChange('ai_insights', 'summary', content.summary, s.proposed!)
          patch(p => ({ ...p, summary: s.proposed! }), 'summary')
          toast.success('Summary updated', 'AI-rewritten summary applied')
        } else { toast.success('Noted', 'Suggestion marked as applied') }
        break

      case 'skills':
        if (s.action === 'reorder' && hasProposed) {
          const reordered = s.proposed!.split(/[,;]\s*/).map(x => x.trim()).filter(Boolean)
          if (reordered.length > 0) {
            recordResumeChange('ai_insights', 'skills', content.skills, reordered)
            patch(p => ({ ...p, skills: reordered }), 'skills')
            toast.success('Skills reordered', `${reordered.length} skills reorganised for ATS`)
          }
        } else if (s.action === 'add_keywords' && scoreResult?.missingItems?.length) {
          // Add ALL section-targeted missing keywords
          const skillsKw = scoreResult.missingItems.filter(m => m.target === 'skills').map(m => m.keyword)
          if (skillsKw.length > 0) {
            const before = content.skills ?? []
            const existing = new Set(before.map(sk => sk.toLowerCase()))
            const added = skillsKw.filter(kw => !existing.has(kw.toLowerCase()))
            if (added.length > 0) {
              const after = [...before, ...added]
              recordResumeChange('ai_insights', 'skills', before, after)
              patch(p => ({ ...p, skills: after }), 'skills')
              toast.success('Skills updated', `Added ${added.length} targeted keyword(s)`)
            }
          }
          // Also toast for non-skills keywords
          const otherKw = scoreResult.missingItems.filter(m => m.target !== 'skills')
          if (otherKw.length > 0) {
          toast.success(t('resume.toastOtherGaps'), `${t('resume.toastAlsoCheck')}: ${otherKw.map(m => m.keyword).join(', ')}`)
          }
        } else { toast.success('Noted', 'Suggestion marked as applied') }
        break

      case 'experience':
        if (s.action === 'enhance' && hasProposed) {
          toast.success(t('resume.toastExperienceTip'), t('resume.toastExperienceTipDetail'))
        } else { toast.success('Noted', 'Suggestion marked as applied') }
        break

      default:
        toast.success('Noted', 'Suggestion marked as applied')
    }
    // Save updated suggestions to localStorage
    try {
      const updated = suggestions.map((sug, idx) => idx === i ? { ...sug, applied: true } : sug)
      const job = jobs.find(j => j.id === selectedJobId)
      saveCache({
        resumeId: selectedResumeId,
        jobId: selectedJobId,
        resumeUpdatedAt: analysisRevisionRef.current,
        jobTitle: job?.role ?? '',
        jobCompany: job?.company ?? '',
        score: scoreResult,
        suggs: updated,
      })
    } catch {}
  }

  // ── Section ordering ──────────────────────────────────────────────────────

  function handleSectionDrop(targetIdx: number) {
    const from = sectionDragRef.current
    if (from === null || from === targetIdx) { setSectionDragOver(null); return }
    const next = [...latestSectionOrder.current]; const [item] = next.splice(from, 1); next.splice(targetIdx, 0, item)
    latestSectionOrder.current = next
    setSectionOrder(next); sectionDragRef.current = null; setSectionDragOver(null); setDirty(true)
  }

  function removeSection(id: string) {
    const next = latestSectionOrder.current.filter(s => s !== id)
    latestSectionOrder.current = next
    setSectionOrder(next); setDirty(true)
  }

  function addSection(id: string) {
    const next = [...latestSectionOrder.current, id]
    latestSectionOrder.current = next
    setSectionOrder(next); setDirty(true)
  }

  function addCustomSection() {
    const id = `custom_${Date.now()}`
    patch(p => ({ ...p, custom: [...(p.custom ?? []), { id, title: 'CUSTOM SECTION', items: [] }] }))
    const next = [...latestSectionOrder.current, id]
    latestSectionOrder.current = next
    setSectionOrder(next)
    setDirty(true)
  }

  function getDragHandleProps(i: number): DragHandleProps {
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => { e.stopPropagation(); sectionDragRef.current = i },
    }
  }

  // ── Direction filter ──────────────────────────────────────────────────────

  const filteredResumes = selectedDirId
    ? resumes.filter(r => r.directionId === selectedDirId)
    : resumes

  // ── Job context for AI ────────────────────────────────────────────────────

  const selectedJob  = jobs.find(j => j.id === selectedJobId) ?? null
  const selectedResume = resumes.find(r => r.id === selectedResumeId) ?? null
  const resumeLinkedJob = jobs.find(j => j.id === selectedResume?.targetJobId)
    ?? jobs.find(j => j.finalResumeId === selectedResumeId)
    ?? null
  const confirmedJob = jobs.find(j => j.finalResumeId === selectedResumeId) ?? null
  // The sidebar must only describe an actual resume ↔ job link. Falling back to
  // a previously selected job kept stale opportunity details visible after a
  // resume switch or after cancelling a link.
  const linkedJob = resumeLinkedJob
  const linkedJobId = selectedResume?.targetJobId ?? resumeLinkedJob?.id
    ?? (selectedResumeId === returnResumeId ? returnJobId : null)
  useEffect(() => {
    if (!linkedJobId || jobs.some(job => job.id === linkedJobId)) return
    let cancelled = false
    // The linked opportunity may be outside the first page of the job list.
    void fetch(`/api/jobs/${encodeURIComponent(linkedJobId)}`)
      .then(response => response.ok ? response.json() as Promise<Job> : null)
      .then(job => {
        if (!cancelled && job?.id === linkedJobId
          && (selectedResume?.targetJobId === job.id || job.finalResumeId === selectedResumeId)) {
          setJobs(previous => previous.some(item => item.id === job.id) ? previous : [...previous, job])
        }
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [linkedJobId, jobs, selectedResume?.targetJobId, selectedResumeId])

  async function returnToApplication(jobId: string) {
    // Record the user's navigation intent immediately. The shell guard waits
    // for the shared save chain and resolves competing requests in click order.
    const opened = await openApplication(jobId, navigate)
    if (!opened && isSavingRef.current) toast.info(t('resume.toastSaving'), t('resume.toastSavingDetail'))
  }
  const templateName = TEMPLATES.find(template => template.id === templateId)?.name ?? templateId
  const pendingSuggestions = suggestions.filter(suggestion => !isAuditSuggestion(suggestion) && !suggestion.applied).length
  const { data: linkedCoverLetters, refetch: refetchLinkedCoverLetters } = useApi<CoverLetter[]>(`/api/jobs/${resumeLinkedJob?.id ?? '__none__'}/cover-letters`)
  const finalCoverLetter = resumeLinkedJob && selectedResumeId ? selectApplicationCoverLetter({
    jobId: resumeLinkedJob.id,
    resumeId: selectedResumeId,
    finalResumeId: resumeLinkedJob.finalResumeId,
    finalCoverLetterId: resumeLinkedJob.finalCoverLetterId,
  }, linkedCoverLetters ?? [], latestSavedCoverLetter) : null
  const { data: storedApplicationAudit } = useApi<StoredApplicationAudit | null>(`/api/jobs/${resumeLinkedJob?.id ?? '__none__'}/audit-application`)
  const currentApplicationAuditRecord = auditMatchesCurrentMaterials(
    latestApplicationAudit,
    selectedResumeId,
    finalCoverLetter?.id ?? null,
    selectedResumeUpdatedAt,
    finalCoverLetter?.updatedAt ?? null,
    dirty || saving,
  )
    ? latestApplicationAudit
    : auditMatchesCurrentMaterials(
        storedApplicationAudit,
        selectedResumeId,
        finalCoverLetter?.id ?? null,
        selectedResumeUpdatedAt,
        finalCoverLetter?.updatedAt ?? null,
        dirty || saving,
      )
      ? storedApplicationAudit
      : null
  const auditIdentity = resumeLinkedJob && currentApplicationAuditRecord
    ? { jobId: resumeLinkedJob.id, resumeId: currentApplicationAuditRecord.resumeId, auditedAt: currentApplicationAuditRecord.audit.auditedAt }
    : null
  const currentApplicationAudit = !sameApplicationAudit(auditIdentity, invalidatedAudit)
    ? currentApplicationAuditRecord?.audit ?? null : null
  const applicationMaterialsConfirmed = Boolean(
    currentApplicationAudit?.verdict === 'pass'
    && !dirty && !saving
    && resumeLinkedJob?.finalResumeId === selectedResumeId
    && (resumeLinkedJob?.finalCoverLetterId ?? null) === (finalCoverLetter?.id ?? null),
  )
  const displayedApplicationAuditRecord = [latestApplicationAudit, storedApplicationAudit].find(record =>
    record
      && record.resumeId === selectedResumeId
      && record.coverLetterId === (finalCoverLetter?.id ?? null),
  ) ?? null
  const displayedApplicationAudit = displayedApplicationAuditRecord?.audit ?? null
  const auditStale = Boolean(displayedApplicationAuditRecord && !auditMatchesCurrentMaterials(
    displayedApplicationAuditRecord,
    selectedResumeId,
    finalCoverLetter?.id ?? null,
    selectedResumeUpdatedAt,
    finalCoverLetter?.updatedAt ?? null,
    dirty || saving,
  ))
  const jobContext: AiFieldContext = selectedJob ? {
    jobTitle:       selectedJob.role,
    jobCompany:     selectedJob.company,
    jobDescription: selectedJob.description ?? undefined,
  } : {}

  async function linkResumeToJob(jobId: string) {
    if (!selectedResumeId) return
    const { data, error } = await apiMutate<Resume>(`/api/resume/${selectedResumeId}`, 'PATCH', { targetJobId: jobId })
    if (!data || error) { toast.error('Could not link resume', error ?? 'Please try again'); return }
    setResumes(prev => prev.map(resume => resume.id === selectedResumeId ? { ...resume, targetJobId: jobId, updatedAt: data.updatedAt } : resume))
    setSelectedJobId(jobId)
    const job = jobs.find(item => item.id === jobId)
    toast.success('Resume linked', `This version is linked to ${job?.company ?? 'the saved job'} — confirm it when ready`)
  }

  async function auditApplicationPack(): Promise<ApplicationAudit | null> {
    setAuditError(null)
    if (!selectedResumeId || !resumeLinkedJob) {
      const message = 'Link a saved job first'
      setAuditError(message)
      toast.info(message, 'Choose an opportunity in My Jobs before running the independent audit')
      return null
    }
    if (saving) {
      const message = t('resume.toastSaving')
      setAuditError(message)
      toast.info(message, t('resume.toastSavingDetail'))
      return null
    }
    if (dirty) {
      const saved = await handleSave()
      if (!saved) return null
    }
    const { data, error } = await apiMutate<ApplicationAuditResponse>(`/api/jobs/${resumeLinkedJob.id}/audit-application`, 'POST', {
      resumeId: selectedResumeId,
      ...(finalCoverLetter ? { coverLetterId: finalCoverLetter.id } : {}),
    })
    if (!data || error) {
      const message = error ?? 'Please try again'
      setAuditError(message)
      toast.error('Audit could not run', message)
      return null
    }
    setAuditError(null)
    setLatestApplicationAudit({
      resumeId: selectedResumeId,
      coverLetterId: finalCoverLetter?.id ?? null,
      resumeUpdatedAt: data.resumeUpdatedAt ?? selectedResumeUpdatedAt ?? undefined,
      coverLetterUpdatedAt: data.coverLetterUpdatedAt ?? finalCoverLetter?.updatedAt,
      audit: data,
    })
    // Keep the Resume page in sync without replacing unrelated AI suggestions
    // or re-triggering a full analysis. Audit findings stay in the audit card;
    // they are not duplicated as generic "Other suggestions".
    const syncedSuggestions = withoutAuditSuggestions(suggestions)
    setSuggestions(syncedSuggestions)
    saveCache({
      resumeId: selectedResumeId,
      jobId: resumeLinkedJob.id,
      resumeUpdatedAt: analysisRevisionRef.current,
      score: scoreResult,
      suggs: syncedSuggestions,
    })
    if (data.verdict !== 'pass') toast.warning('Audit needs revision', `${data.summary} Review the findings in the audit card.`)
    return data
  }

  async function runResumeAudit() {
    if (auditRunRef.current) return
    auditRunRef.current = true
    setAuditingApplication(true)
    try {
      await auditApplicationPack()
    } finally {
      auditRunRef.current = false
      setAuditingApplication(false)
    }
  }

  function reviewAuditFinding(area: ApplicationAuditFinding['area']) {
    if (area === 'cover_letter') {
      setShowCoverLetter(true)
      return
    }
    if (area === 'job_match') {
      toast.info('Review job match', 'This finding is guidance about the role, not a resume edit.')
      return
    }
    document.querySelector<HTMLElement>('[data-resume-editor]')?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function applyAuditFinding(index: number) {
    if (!selectedResumeId || !resumeLinkedJob || !displayedApplicationAuditRecord || auditStale) {
      toast.info('Run the audit again first', 'The current resume or cover letter changed after this audit.')
      return
    }
    if (correctionConflictRef.current) {
      toast.warning(t(versionRestoreUnknownRef.current ? 'resume.restoreUnknownTitle' : 'resume.correctionChangedTitle'),
        t(versionRestoreUnknownRef.current ? 'resume.restoreUnknownDetail' : 'resume.correctionChangedDetail'))
      return
    }
    if (dirtyRef.current && !isSavingRef.current) {
      toast.info(t('resume.correctionSaveFirstTitle'), t('resume.correctionSaveFirstDetail'))
      return
    }
    if (isSavingRef.current || applyingAuditRef.current) {
      toast.info(t('resume.toastSaving'), t('resume.toastSavingDetail'))
      return
    }
    const finding = displayedApplicationAuditRecord.audit.findings[index]
    const expectedTarget = finding ? targetForAuditFinding(finding) : undefined
    const beforeChange = expectedTarget === 'cover_letter'
      ? finalCoverLetter?.content
      : expectedTarget ? currentResumeSectionValue(expectedTarget) : undefined
    const requestUserId = resumeUserIdRef.current
    const requestResumeId = selectedResumeId
    const requestEditRevision = editRevisionRef.current
    if (!requestUserId) return
    // A pending GET must not overwrite a server-side correction even if the
    // user has not edited the cached resume locally.
    saveGenerationRef.current += 1
    applyingAuditRef.current = true
    setApplyingAuditFinding(index)
    try {
      const { data, error } = await apiMutate<AuditApplyResponse>(`/api/jobs/${resumeLinkedJob.id}/audit-application/apply`, 'POST', {
        resumeId: selectedResumeId,
        coverLetterId: finalCoverLetter?.id ?? null,
        findingIndex: index,
      })
      if (!mountedRef.current || requestUserId !== resumeUserIdRef.current
        || requestResumeId !== selectedResumeIdRef.current) return
      if (!data || error) {
        if (requestEditRevision !== editRevisionRef.current) {
          correctionConflictRef.current = true
          setContentChangedSinceAnalysis(true)
          toast.warning(t('resume.correctionChangedTitle'), t('resume.correctionChangedDetail'))
          return
        }
        toast.error('Could not apply audit correction', error ?? 'Please run the audit again')
        return
      }

      if (data.resume) {
        analysisEpochRef.current += 1
        setScoring(false)
        setSuggesting(false)
        if (requestEditRevision !== editRevisionRef.current) {
          correctionConflictRef.current = true
          setContentChangedSinceAnalysis(true)
          toast.warning(t('resume.correctionChangedTitle'), t('resume.correctionChangedDetail'))
          return
        }
        setContent(data.resume.content)
        setSectionOrder(data.resume.content.sectionOrder ?? DEFAULT_ORDER)
        setDirty(false)
        setContentChangedSinceAnalysis(true)
        setCachedApiResponse(`/api/resume/${selectedResumeId}`, data.resume, resumeUserIdRef.current)
        setContentRevision(data.resume.updatedAt ?? null)
        setResumes(previous => previous.map(resume => resume.id === data.resume?.id
          ? { ...resume, name: data.resume.name, updatedAt: data.resume.updatedAt }
          : resume))
      }
      if (data.coverLetter) setLatestSavedCoverLetter(data.coverLetter)
      if (data.target) {
        const afterChange = data.target === 'cover_letter'
          ? data.coverLetter?.content
          : data.resume ? currentResumeSectionValue(data.target, data.resume.content as ResumeContent) : undefined
        recordResumeChange('audit', data.target, beforeChange, afterChange)
      }
      setLatestApplicationAudit({
        ...displayedApplicationAuditRecord,
        resumeUpdatedAt: data.resumeUpdatedAt ?? displayedApplicationAuditRecord.resumeUpdatedAt,
        coverLetterUpdatedAt: data.coverLetterUpdatedAt ?? displayedApplicationAuditRecord.coverLetterUpdatedAt,
        audit: data.audit,
      })
      toast.success('Audit correction applied', 'The finding stays visible as Applied. Re-run the audit when you are ready to verify the package again.')
    } finally {
      applyingAuditRef.current = false
      setApplyingAuditFinding(null)
      if (mountedRef.current && requestUserId === resumeUserIdRef.current && requestResumeId === selectedResumeIdRef.current
        && dirtyRef.current && !correctionConflictRef.current) void handleSave()
    }
  }

  async function confirmApplicationPack(audit: ApplicationAudit): Promise<boolean> {
    if (!selectedResumeId || !resumeLinkedJob) return false
    if (audit.verdict !== 'pass' || currentApplicationAudit?.auditedAt !== audit.auditedAt || dirty || saving) {
      toast.warning('Audit must pass', 'Resolve all Auditor findings before confirming this application package.')
      return false
    }
    const assignment = applicationMaterialAssignment(selectedResumeId, finalCoverLetter?.id ?? null, resumeLinkedJob.finalCoverLetterId)
    const { data, error } = await apiMutate<Job>(`/api/jobs/${resumeLinkedJob.id}/assign`, 'PATCH', assignment)
    if (!data || error) {
      toast.error('Could not confirm application pack', error ?? 'Please try again')
      return false
    }
    setJobs(previous => previous.map(job => job.id === data.id ? data : job))
    if (assignment.finalCoverLetterId) {
      setInvalidatedAudit({ jobId: resumeLinkedJob.id, resumeId: selectedResumeId, auditedAt: audit.auditedAt })
      // Selecting a different letter changes its server revision. Reload it
      // and require an audit of that revision instead of inventing readiness.
      setLatestSavedCoverLetter(null)
      setLatestApplicationAudit(null)
      await refetchLinkedCoverLetters()
      toast.info(t('resume.materialSelectionChanged'), t('resume.materialSelectionRecheck'))
      return false
    }
    setResumes(previous => previous.map(resume => {
      if (resume.id === selectedResumeId) {
        return { ...resume, _count: { finalForJobs: Math.max(1, resume._count?.finalForJobs ?? 0) } }
      }
      if (resume.id === resumeLinkedJob.finalResumeId) {
        return { ...resume, _count: { finalForJobs: 0 } }
      }
      return resume
    }))
    toast.success('Application pack confirmed', finalCoverLetter
      ? 'Audited final resume and cover letter are ready in Applications and for PDF export'
      : 'Audited final resume is ready in Applications and for PDF export')
    if (returnToJobs) {
      openApplication(data.id, navigate)
    }
    return true
  }

  async function downloadApplicationPack() {
    if (!confirmedJob) return
    try {
      const result = await exportApplicationPackLocally(confirmedJob.id, Boolean(exportedPackFolder))
      setExportedPackFolder(result.folderPath)
      toast.success(exportedPackFolder ? 'Job folder opened' : 'Application PDFs saved', result.folderPath)
    } catch (error) {
      toast.error('Could not create application pack', error instanceof Error ? error.message : 'Please try again')
    }
  }

  async function exportCurrentResumePdf() {
    if (!selectedResumeId || !content || !selectedResume) { toast.info(t('resume.selectFirst')); return }
    if (exportingPdf) return
    setExportingPdf(true)
    try {
      if (dirty && !(await handleSave())) return
      await downloadResumePdf({
        ...selectedResume,
        name: latestResumeName.current,
        content: { ...(latestContent.current ?? content), sectionOrder: latestSectionOrder.current },
        templateId: latestTemplateId.current,
        templateOptions: latestTemplateOptions.current,
      })
      toast.success(t('resume.exportSuccess'))
    } catch (error) {
      console.error('[resume] PDF export failed', error)
      toast.error(t('resume.exportError'), t('resume.exportErrorFallback'))
    } finally {
      setExportingPdf(false)
    }
  }

  async function handleRenameResume(resume: ResumeListItem, name: string) {
    if (!name || name === resume.name) { setRenamingResume(null); return }
    const { data, error } = await apiMutate<Resume>(`/api/resume/${resume.id}`, 'PATCH', { name })
    if (!data) return toast.error('Rename failed', error ?? 'Could not rename resume')
    setResumes(prev => prev.map(item => item.id === resume.id ? { ...item, name: data.name, updatedAt: data.updatedAt } : item))
    if (resume.id === selectedResumeId) setResumeName(data.name)
    toast.success('Resume renamed', data.name)
    setRenamingResume(null)
  }

  async function handleSetDefaultResume(resume: ResumeListItem) {
    const { data, error } = await apiMutate<Resume>(`/api/resume/${resume.id}`, 'PATCH', { isDefault: true })
    if (!data || error) { toast.error('Could not set default', error ?? 'Please try again'); return }
    setResumes(previous => previous.map(item => ({ ...item, isDefault: item.id === resume.id })))
    toast.success('Default resume updated', `${data.name} is now your default resume`)
  }

  async function handleUnlinkResume(resume: ResumeListItem) {
    const ok = await confirm({
      title: 'Cancel job link?',
      message: 'This will remove the job connection and clear its Final status. Your resume and cover letter files will stay intact.',
      danger: true,
      confirmLabel: 'Cancel link',
    })
    if (!ok) return

    const { data, error } = await apiMutate<Resume>(`/api/resume/${resume.id}`, 'PATCH', { unlinkJob: true })
    if (!data || error) { toast.error('Could not cancel link', error ?? 'Please try again'); return }
    setResumes(previous => previous.map(item => item.id === resume.id
      ? { ...item, targetJobId: null, _count: { finalForJobs: 0 }, updatedAt: data.updatedAt }
      : item))
    setJobs(previous => previous.map(job => job.finalResumeId === resume.id ? { ...job, finalResumeId: null } : job))
    if (resume.id === selectedResumeId) {
      setSelectedJobId(null)
      setScoreResult(null)
      setSuggestions([])
      analysisTargetRef.current = null
    }
    toast.success('Job link removed', 'The resume is no longer marked as Final for that job')
  }

  async function handleDeleteResume(resume: ResumeListItem) {
    if (resumes.length <= 1) return toast.error('Keep one resume', 'Create another version before deleting this resume.')
    const approved = await confirm({ title: 'Delete resume?', message: `Delete “${resume.name}”? This cannot be undone.`, danger: true, confirmLabel: 'Delete' })
    if (!approved) return
    if (resume.id === selectedResumeIdRef.current && (dirtyRef.current || isSavingRef.current)) {
      if (!(await handleSave()) || dirtyRef.current || isSavingRef.current) return
    }
    const { error } = await apiMutate(`/api/resume/${resume.id}`, 'DELETE')
    if (error) return toast.error('Delete failed', error)
    const next = resumes.filter(item => item.id !== resume.id)
    setResumes(next)
    if (resume.id === selectedResumeIdRef.current) setSelectedResumeId(next[0]?.id ?? null)
    toast.success('Resume deleted', resume.name)
  }

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
        onChange={s => patch(p => ({ ...p, summary: s }), 'summary')}
        jobContext={jobContext}
        dragHandleProps={dh}
        onRemove={() => removeSection(sectionId)}
        flash={flashField === 'summary'}
      />
    )
    if (sectionId === 'experience') return (
      <ExperienceSection key={sectionId}
        experience={content.experience}
        jobContext={jobContext}
        onChange={exp => patch(p => ({ ...p, experience: exp }), 'experience')}
        dragHandleProps={dh}
        onRemove={() => removeSection(sectionId)}
        flashField={flashField}
      />
    )
    if (sectionId === 'skills') return (
      <SkillsSection key={sectionId}
        skills={content.skills}
        matchedKeywords={scoreResult?.matchedKeywords ?? []}
        onChange={sk => patch(p => ({ ...p, skills: sk }), 'skills')}
        dragHandleProps={dh}
        onRemove={() => removeSection(sectionId)}
        flash={flashField === 'skills'}
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
        onChange={projects => patch(p => ({ ...p, projects: projects.length > 0 ? projects : undefined }), 'projects')}
        dragHandleProps={dh}
        onRemove={() => removeSection(sectionId)}
        flashField={flashField}
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

  function openIntake(file: File | null = null) {
    setIntakeFile(file)
    setShowIntakeDialog(true)
  }

  function handleLibraryImportDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setLibraryImportDragOver(false)
    const file = event.dataTransfer.files.item(0)
    if (file) openIntake(file)
  }

  async function selectResume(id: string, suppliedTarget?: ResumeListItem): Promise<boolean> {
    const attempt = ++resumeSelectionAttempt.current
    if (id === selectedResumeIdRef.current) return true
    if (applyingAuditRef.current || versionRestoreIntentRef.current) {
      toast.info(t('resume.toastSaving'), t('resume.toastSavingDetail'))
      return false
    }
    if (dirtyRef.current || isSavingRef.current) {
      if (!(await handleSave()) || dirtyRef.current || isSavingRef.current) return false
    }
    if (!mountedRef.current || attempt !== resumeSelectionAttempt.current) return false
    const target = suppliedTarget ?? resumes.find(r => r.id === id)
    setShowFinalConfirm(false)
    if (target) setResumeName(target.name)
    setSelectedResumeId(id)
    setSelectedJobId(target?.targetJobId ?? jobs.find(job => job.finalResumeId === id)?.id ?? null)
    return true
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const formatTools: Array<{ key: string; label: string; title: string; group: 'emphasis' | 'structure'; wrap: [string, string]; style?: React.CSSProperties }> = [
    { key: 'B', label: 'B', title: 'Bold', group: 'emphasis', wrap: ['**', '**'], style: { fontWeight: 700 } },
    { key: 'I', label: 'I', title: 'Italic', group: 'emphasis', wrap: ['_', '_'], style: { fontStyle: 'italic' } },
    { key: 'U', label: 'U', title: 'Underline', group: 'emphasis', wrap: ['<u>', '</u>'], style: { textDecoration: 'underline' } },
    { key: 'H1', label: 'H1', title: 'Heading 1', group: 'structure', wrap: ['# ', ''] },
    { key: 'H2', label: 'H2', title: 'Heading 2', group: 'structure', wrap: ['## ', ''] },
    { key: '•', label: '•', title: 'Bullet point', group: 'structure', wrap: ['• ', ''] },
  ]

  const renderFormatTools = (group: 'emphasis' | 'structure') => formatTools.filter(tool => tool.group === group).map(tool => (
    <button
      key={tool.key}
      className={`resume-format-button resume-format-button-${tool.key === '•' ? 'bullet' : tool.key.toLowerCase()}`}
      onMouseDown={event => event.preventDefault()}
      onClick={() => applyFormat(tool.wrap)}
      title={tool.title}
      aria-label={tool.title}
      style={tool.style}
    >
      {tool.label}
    </button>
  ))

  return (
    <div className="resume-library-page" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <ConfirmDialog />
      <header className="resume-library-heading">
        <div>
          <h1>{t('resume.library')}</h1>
          {returnToJobs && (returnJobId || linkedJobId) && <button disabled={saving} onClick={() => void returnToApplication(returnJobId || linkedJobId!)} style={{ marginTop: 4, padding: 0, border: 'none', background: 'none', color: 'var(--primary)', cursor: 'pointer', fontSize: 12 }}>← {t('resume.backToApplication')}</button>}
        </div>
      <div className="resume-library-toolbar">
        <div className="resume-library-toolbar-actions">
          <Btn variant="primary" onClick={() => openIntake()}><Upload size={15} />{t('resume.importParse')}</Btn>
        </div>
        <span className="resume-toolbar-divider" />
        <Btn variant="ghost" onClick={() => setShowTemplates(true)}><LayoutTemplate size={15} />{t('resume.templates')}</Btn>
        <span className="resume-toolbar-divider" />
        <Btn variant="ghost" onClick={() => { if (!selectedResumeId) { toast.info(t('resume.selectFirst')); return }; fetchVersions(); setShowVersions(true) }}><History size={15} />{t('resume.history')}</Btn>
        <span className="resume-toolbar-divider" />
        <Btn variant="ghost" onClick={() => void exportCurrentResumePdf()} disabled={exportingPdf}><FileDown size={15} />{exportingPdf ? t('resume.exportPreparing') : t('resume.exportPdf')}</Btn>
        <div className="resume-final-confirm-trigger"><Btn variant="toolbar" onClick={() => {
          if (!selectedResumeId || !content) { toast.info('Select a resume first'); return }
          setShowFinalConfirm(true)
        }}><ShieldCheck size={15} />{t('resume.confirmMaterials')}</Btn></div>
        <span className={`resume-top-save${dirty ? ' is-unsaved' : ''}`}>{saving ? t('resume.savingStatus') : dirty ? t('resume.savingSoon') : lastSavedAt && Date.now() - lastSavedAt.getTime() >= 5 * 60_000 ? `${t('resume.savedAt')} ${lastSavedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : t('resume.savedJustNow')}</span>
      </div>
      </header>

      {loadingCont ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-tertiary)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 28, height: 28, border: '2.5px solid rgba(79,70,229,0.20)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('resume.loading')}</div>
          </div>
        </div>
      ) : !content ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-tertiary)' }}>
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>{t('resume.selectOrCreate')}</div>
        </div>
      ) : (
        <div
          className={`resume-library-layout${libraryCollapsed ? ' is-library-collapsed' : ''}${libraryCollapsing ? ' is-library-collapsing' : ''}${libraryResizing ? ' is-library-resizing' : ''}${aiPanelResizing ? ' is-ai-panel-resizing' : ''}`}
          style={{ '--resume-library-width': `${libraryCollapsed ? RESUME_LIBRARY_COLLAPSED_WIDTH : libraryWidth}px`, '--resume-ai-width': `${aiPanelWidth}px`, flex: 1, display: 'flex', overflow: 'hidden', background: 'var(--bg-tertiary)' } as React.CSSProperties}
        >
          <aside className="resume-library-sidebar">
            {libraryCollapsed ? (
              <div className="resume-library-collapsed-list" aria-label={t('resume.thumbnails')}>
                {filteredResumes.map(resume => {
                  const isSelected = resume.id === selectedResumeId
                  return (
                    <button
                      key={resume.id}
                      type="button"
                      className={`resume-library-collapsed-item${isSelected ? ' is-selected' : ''}`}
                      aria-label={resume.name}
                      title={resume.name}
                      onClick={() => { void selectResume(resume.id) }}
                    >
                      <FileText size={18} strokeWidth={1.7} />
                    </button>
                  )
                })}
              </div>
            ) : <>
            <div className="resume-library-sidebar-head">
              <div>
                <span>{t('resume.myResumes')}</span>
                <small>{resumes.length} version{resumes.length === 1 ? '' : 's'}</small>
              </div>
              <button onClick={() => setShowNewResume(true)} disabled={creatingResume}><Plus size={13} />{t('resume.newVersion')}</button>
            </div>
            <ResumeLibraryPanel
              resumes={filteredResumes}
              directions={directions}
              selectedId={selectedResumeId}
              onSelect={selectResume}
              onRename={resume => setRenamingResume(resume)}
              onDelete={handleDeleteResume}
              onSetDefault={handleSetDefaultResume}
              onUnlink={handleUnlinkResume}
            />
            <div
              className={`resume-library-import${libraryImportDragOver ? ' is-drag-over' : ''}`}
              aria-label={t('resume.dropResume')}
              onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setLibraryImportDragOver(true) }}
              onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setLibraryImportDragOver(false) }}
              onDrop={handleLibraryImportDrop}
            >
              <span className="resume-library-file-icon"><Upload size={18} strokeWidth={1.7} /></span>
              <span className="resume-library-import-copy">
                <strong>{libraryImportDragOver ? 'Drop to import your resume' : 'Drop a PDF or DOCX to import'}</strong>
                <small>{t('resume.pdfDocxLimit')}</small>
              </span>
            </div>
            </>}
          </aside>
          <div
            className="resume-library-resize-handle"
            role="separator"
            aria-label={t('resume.resizeLibrary')}
            aria-orientation="vertical"
            aria-valuemin={RESUME_LIBRARY_COLLAPSED_WIDTH}
            aria-valuemax={RESUME_LIBRARY_MAX_WIDTH}
            aria-valuenow={libraryCollapsed ? RESUME_LIBRARY_COLLAPSED_WIDTH : libraryWidth}
            tabIndex={0}
            onPointerDown={handleLibraryResizeStart}
            onPointerMove={handleLibraryResizeMove}
            onPointerUp={handleLibraryResizeEnd}
            onPointerCancel={handleLibraryResizeEnd}
            onKeyDown={handleLibraryResizeKeyDown}
          >
            <span aria-hidden="true" />
          </div>
          <div className="resume-workspace" data-resume-editor style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
            {/* Empty-state banner: no directions set up */}
            {directions.length === 0 && (
              <div style={{ padding: '8px 12px', background: 'rgba(217,119,6,0.06)', border: '0.5px solid rgba(217,119,6,0.20)', borderRadius: 7, marginBottom: 12, fontSize: 11, color: 'var(--c-warning)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>{t('resume.directionsMissing')}</span>
                <button
                  onClick={() => toast.info('Setup', 'Go to Settings → Profile to restart onboarding')}
                  style={{ fontSize: 10, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
                >
                  Start setup
                </button>
              </div>
            )}
            <div className="resume-editor-content">
            <div className="resume-workspace-head">
              <div className="resume-workspace-title-copy">
                <div className="resume-workspace-eyebrow">
                  <span className="resume-workspace-eyebrow-icon"><FileText size={12} aria-hidden="true" /></span>
                  <span>{t('resume.editor')}</span>
                </div>
                <div className="resume-workspace-name-row">
                  <h2>{resumeName}</h2>
                  {selectedResume?.kind === 'adapted' && <span className="resume-workspace-version-chip">{t('resume.tailoredVersion')}</span>}
                  {selectedResume?.isDefault && <span className="resume-workspace-version-chip is-default">{t('resume.default')}</span>}
                </div>
              </div>
              <div className="resume-workspace-actions">
                <button className="resume-workspace-preview-button" onClick={() => setPreviewMode(value => !value)} aria-pressed={previewMode}>
                  <span className="resume-workspace-preview-icon"><Eye size={15} aria-hidden="true" /></span>
                  <span>{previewMode ? 'Edit resume' : 'Preview'}</span>
                </button>
              </div>
            </div>
            {/* ── PREVIEW MODE ── */}
            {previewMode && <ResumePreview content={{ ...content, sectionOrder }} templateId={templateId} templateOptions={templateOptions} />}
            {/* Format toolbar + Editor (hidden in preview mode) */}
            {!previewMode && (<>

            {/* Format toolbar */}
            <div className="resume-format-toolbar" role="toolbar" aria-label="Resume formatting tools">
              <div className="resume-format-toolbar-title">
                <span className="resume-format-toolbar-icon"><Type size={14} aria-hidden="true" /></span>
                <span className="resume-format-toolbar-copy">
                  <strong>Format text</strong>
                  <small>Select text in the resume first</small>
                </span>
              </div>
              <div className="resume-format-toolbar-groups">
                <div className="resume-format-group" role="group" aria-label="Text emphasis">
                  <span className="resume-format-group-label">Text</span>
                  {renderFormatTools('emphasis')}
                </div>
                <span className="resume-format-toolbar-divider" aria-hidden="true" />
                <div className="resume-format-group" role="group" aria-label="Text structure">
                  <span className="resume-format-group-label">Structure</span>
                  {renderFormatTools('structure')}
                </div>
              </div>
            </div>

            {/* Completeness bar */}
            <CompletenessBar content={content} />

            <ResumeChangeSummary
              changes={resumeChanges}
              onDismiss={dismissResumeChange}
              onClear={() => setResumeChanges([])}
            />

            {/* Resume paper */}
            <div className="resume-paper" style={{ margin: '0 auto', background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 10, padding: '32px 36px' }}>
              {/* Contact (fixed, not draggable) */}
              <div className={`resume-editor-section-shell${resumeChanges.some(change => change.section === 'contact') ? ' has-resume-changes' : ''}`}>
                {renderSectionChangeMarker('contact')}
                <ContactSection
                  contact={content.contact}
                  editing={editSection === 'contact'}
                  onEdit={() => setEditSection('contact')}
                  onBlur={() => setEditSection(null)}
                  onChange={c => patch(p => ({ ...p, contact: c }))}
                />
              </div>

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
                  <div className={`resume-editor-section-shell${resumeChanges.some(change => change.section === sectionId) ? ' has-resume-changes' : ''}`}>
                    {renderSectionChangeMarker(sectionId as ResumeChangeSection)}
                    {renderSection(sectionId, sectionIdx)}
                  </div>
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
                  style={{ fontSize: 11, color: 'var(--primary)', background: 'rgba(79,70,229,0.06)', border: '0.5px dashed rgba(79,70,229,0.30)', borderRadius: 6, padding: '6px 20px', cursor: 'pointer' }}>
                  + Add Section
                </button>
              </div>
             </div>
             </>)}
            </div>
           </div>

          <div
            className="resume-ai-resize-handle"
            role="separator"
            aria-label={t('resume.resizeAiPanel')}
            aria-orientation="vertical"
            aria-valuemin={AI_PANEL_MIN_WIDTH}
            aria-valuemax={AI_PANEL_MAX_WIDTH}
            aria-valuenow={aiPanelWidth}
            tabIndex={0}
            onPointerDown={handleAiPanelResizeStart}
            onPointerMove={handleAiPanelResizeMove}
            onPointerUp={handleAiPanelResizeEnd}
            onPointerCancel={handleAiPanelResizeEnd}
            onKeyDown={handleAiPanelResizeKeyDown}
          >
            <span aria-hidden="true" />
          </div>
          <aside className="resume-ai-column">
          <div className="resume-ai-title" style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setRightPanel('insights')} style={{ border: 0, background: 'transparent', color: rightPanel === 'insights' ? 'var(--text)' : 'var(--text-muted)', font: 'inherit', fontWeight: 700, cursor: 'pointer', padding: 0 }}>{t('resume.aiInsights')}</button>
            <button onClick={() => setRightPanel('persona')} style={{ border: 0, background: 'transparent', color: rightPanel === 'persona' ? 'var(--primary)' : 'var(--text-muted)', font: 'inherit', fontWeight: 700, cursor: 'pointer', padding: 0 }}>{t('resume.persona')}</button>
          </div>
          {rightPanel === 'persona' ? <PersonaPanel isDefault={selectedResume?.isDefault ?? false} onEditResume={setEditSection} onUseAsProfile={() => { if (selectedResume) void handleSetDefaultResume(selectedResume) }} /> : <>
          <div className="resume-opportunity-card">
            <span className="resume-opportunity-eyebrow">{t('resume.linkedOpportunity')}</span>
            {linkedJob ? <>
              <strong>{linkedJob.role}</strong>
              <span>{linkedJob.company}</span>
              <small>{selectedResume?.targetJobId ? 'Tailored version linked' : 'Selected resume linked'}</small>
              <div className="resume-opportunity-actions">
                <button onClick={() => setShowCoverLetter(true)}>{t('resume.coverLetter')}</button>
                <button disabled={saving} onClick={() => void returnToApplication(linkedJob.id)}>{t('resume.viewApplication')}</button>
              </div>
            </> : <>
              <strong>{t('resume.linkSavedJob')}</strong>
              <span>{t('resume.aiTailorOpportunity')}</span>
              <select value={selectedJobId ?? ''} onChange={e => setSelectedJobId(e.target.value || null)}>
                <option value="">{t('resume.chooseSavedJob')}</option>
                {jobs.map(job => <option key={job.id} value={job.id}>{job.company} · {job.role}</option>)}
              </select>
              <button className="resume-opportunity-link" onClick={() => {
                if (!selectedJobId) { toast.info('Select a saved job first', 'Choose the opportunity this resume should be used for'); return }
                linkResumeToJob(selectedJobId)
              }}>{t('resume.linkResume')}</button>
            </>}
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
            onAddKeyword={kw => patch(p => ({ ...p, skills: [...(p.skills ?? []), kw] }), 'skills')}
            onApplyTargeted={applyTargeted}
            onEditSection={sec => setEditSection(sec)}
            onRegenerateSection={section => void regenerateSection(section)}
            regeneratingSection={regeneratingSection}
            currentSummary={content?.summary}
            currentSkills={content?.skills}
            contentChangedSinceAnalysis={contentChangedSinceAnalysis}
            applicationAudit={displayedApplicationAudit}
            auditing={auditingApplication}
            auditError={auditError}
            auditStale={auditStale}
            applyingAuditFinding={applyingAuditFinding}
            hasLinkedJob={Boolean(resumeLinkedJob)}
            hasCoverLetter={Boolean(finalCoverLetter)}
            onReviewFinding={reviewAuditFinding}
            onApplyAuditFinding={index => void applyAuditFinding(index)}
            onAudit={() => { if (!content) { toast.info('Select a resume first'); return }; void runResumeAudit() }}
          />
          </>}
          </aside>
        </div>
      )}

      {showTemplates && (
        <TemplateModal
          current={templateId}
          currentOptions={templateOptions}
          onSelect={(id, opts) => {
            latestTemplateId.current = id
            latestTemplateOptions.current = opts
            setTemplateId(id)
            setTemplateOptions(opts)
            setDirty(true)
            toast.success('Template applied', TEMPLATES.find(t => t.id === id)?.name ?? id)
          }}
          onClose={() => setShowTemplates(false)}
        />
      )}
      {showCoverLetter && content && selectedJob && (
        <CoverLetterPanel
          job={selectedJob}
          resumeId={selectedResumeId ?? undefined}
          resumeContent={content}
          resumeName={resumeName}
          templateId={templateId}
          templateName={templateName}
          templateOptions={templateOptions}
          onClose={() => setShowCoverLetter(false)}
          onSaved={saved => setLatestSavedCoverLetter(saved)}
        />
      )}
      {showVersions && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) setShowVersions(false) }}>
          <div style={{ background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 10, padding: 20, width: 400, maxHeight: '70vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.15)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <span style={{ fontSize: 14, fontWeight: 500 }}>{t('resume.versionHistory')}</span>
              <button onClick={() => setShowVersions(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'var(--text-muted)', lineHeight: 1, padding: 0 }}>✕</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {loadingVers ? (
                <div style={{ textAlign: 'center', padding: 30, fontSize: 12, color: 'var(--text-muted)' }}>{t('resume.versionsLoading')}</div>
              ) : versions.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 30 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>{t('resume.noVersionsShort')}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('resume.versionsAuto')}</div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {versions.map((v, i) => (
                    <div key={v.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', background: i === 0 ? 'rgba(79,70,229,0.06)' : 'var(--bg-secondary)', borderRadius: 6, border: i === 0 ? '0.5px solid rgba(79,70,229,0.20)' : '0.5px solid var(--border)' }}>
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)' }}>{v.name}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{fmtDate(v.createdAt)} · {fmtRelative(v.createdAt)}</div>
                      </div>
                      <Btn small variant="ghost" disabled={restoring} onClick={() => restoreVersion(v.id)}>
                        Restore
                      </Btn>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {showNewResume && (
        <NewResumeModal onClose={() => setShowNewResume(false)} onCreate={handleCreateResume} />
      )}
      {showFinalConfirm && (
        <FinalConfirmDialog
          key={`${selectedResumeId}:${finalCoverLetter?.id ?? 'no-cover-letter'}`}
          job={resumeLinkedJob}
          resumeName={resumeName}
          templateName={templateName}
          pendingSuggestions={pendingSuggestions}
          isDirty={dirty || saving}
          packReady={applicationMaterialsConfirmed}
          resumeContent={{ ...(content as ResumeContent), sectionOrder }}
          templateId={templateId}
          templateOptions={templateOptions}
          coverLetterContent={finalCoverLetter?.content ?? null}
          initialAudit={currentApplicationAudit}
          onClose={() => setShowFinalConfirm(false)}
          onReviewSuggestions={() => { setShowFinalConfirm(false); toast.info(t('resume.toastSuggestions'), t('resume.toastSuggestionsDetail')) }}
          onCreateCoverLetter={() => { setShowFinalConfirm(false); setShowCoverLetter(true) }}
          onLinkJob={() => {
            setShowFinalConfirm(false)
            if (selectedJobId) { void linkResumeToJob(selectedJobId); return }
            toast.info('Link a saved job', 'Choose a job in the Linked opportunity panel')
          }}
          onReviewAudit={() => {
            setShowFinalConfirm(false)
            window.setTimeout(() => document.querySelector<HTMLElement>('[data-resume-audit-card]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 0)
          }}
          onConfirm={confirmApplicationPack}
          onDownload={downloadApplicationPack}
          exportedPackFolder={exportedPackFolder}
        />
      )}
      {renamingResume && <RenameResumeModal resume={renamingResume} onClose={() => setRenamingResume(null)} onRename={name => handleRenameResume(renamingResume, name)} />}
      {showUploadModal && (
        <UploadResumeModal onClose={() => setShowUploadModal(false)} onImport={handleImportResume} />
      )}
      {showIntakeDialog && (
        <ResumeIntakeDialog
          onClose={() => { setShowIntakeDialog(false); setIntakeFile(null) }}
          onSaved={(resume) => {
            const item: ResumeListItem = {
              id: resume.id, name: resume.name, isDefault: resume.isDefault,
              directionId: resume.directionId, kind: resume.kind,
              parentResumeId: resume.parentResumeId, targetJobId: resume.targetJobId,
              origin: resume.origin, basicsDetached: resume.basicsDetached,
              createdAt: resume.createdAt, updatedAt: resume.updatedAt,
            }
            setResumes(prev => [...prev, item])
            void selectResume(resume.id, item)
            toast.success('Resume saved', `"${resume.name}" added to your library`)
            setIntakeFile(null)
            setShowIntakeDialog(false)
          }}
          directions={directions}
          initialDirId={selectedDirId}
          initialFile={intakeFile}
        />
      )}
      {showAddDirection && (
        <AddDirectionDialog
          onClose={() => setShowAddDirection(false)}
          onCreate={async ({ name, color, icon }) => {
            const { data, error } = await apiMutate<Direction>('/api/directions', 'POST', { name, color, icon })
            if (data) {
              setDirections(prev => [...prev, data])
              setSelectedDirId(data.id)
              setShowAddDirection(false)
            } else toast.error('Error', error ?? 'Could not create direction')
          }}
        />
      )}
    </div>
  )
}
