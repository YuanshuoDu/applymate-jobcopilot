'use client'

import React, { useState, useEffect, useRef } from 'react'
import { TopBar } from '@/components/layout/TopBar'
import { useI18n } from '@/lib/i18n'

// Module-level analysis cache — survives component unmount/remount during tab navigation
const LS_KEY = 'applymate_last_analysis'
let _cachedAnalysis: { resumeId: string; jobId: string; score: ScoreResult | null; suggs: Suggestion[] } | null = null
function loadCache() {
  if (_cachedAnalysis) return _cachedAnalysis
  if (typeof window === 'undefined') return null
  try { _cachedAnalysis = JSON.parse(localStorage.getItem(LS_KEY) ?? 'null'); return _cachedAnalysis } catch { return null }
}
function saveCache(data: { resumeId: string | null; jobId: string | null; score: ScoreResult | null; suggs: Suggestion[]; [k: string]: unknown }) {
  if (!data.jobId || !data.resumeId) return
  _cachedAnalysis = { resumeId: data.resumeId, jobId: data.jobId, score: data.score, suggs: data.suggs }
  try { localStorage.setItem(LS_KEY, JSON.stringify(_cachedAnalysis)) } catch {}
}
import { Btn, useToast, useConfirm } from '@/components/ui'
import { useApi, apiMutate, fmtDate, fmtRelative } from '@/lib/hooks'
import type { ResumeListItem, ResumeContent, Resume, Job, ScoreResult, Suggestion, TemplateOptions, Direction } from '@/lib/types'
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
import { UploadResumeModal } from '@/components/resume/UploadResumeModal'
import { ResumeIntakeDialog } from '@/components/resume/ResumeIntakeDialog'
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
  const color = score >= 80 ? 'var(--c-success)' : score >= 50 ? 'var(--primary)' : 'var(--c-warning)'
  const [showTips, setShowTips] = useState(false)
  return (
    <div style={{ marginBottom: 12, padding: '8px 12px', background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
        <span style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-muted)' }}>RESUME COMPLETENESS</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color }}>{score}%</span>
          {tips.length > 0 && (
            <button onClick={() => setShowTips(v => !v)}
              style={{ fontSize: 9, color: 'var(--primary)', background: 'rgba(79,70,229,0.08)', border: '0.5px solid rgba(79,70,229,0.20)', borderRadius: 10, padding: '1px 7px', cursor: 'pointer' }}>
              {showTips ? 'Hide tips' : `${tips.length} tip${tips.length > 1 ? 's' : ''}`}
            </button>
          )}
          {score === 100 && <span style={{ fontSize: 10, color: 'var(--c-success)' }}>✓ Complete</span>}
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
  const [name, setName] = useState('New Resume')
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 10, padding: 20, width: 340, boxShadow: '0 8px 32px rgba(0,0,0,0.15)' }}>
        <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 12 }}>New Resume</div>
        <input autoFocus value={name} onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onCreate(name.trim()); if (e.key === 'Escape') onClose() }}
          placeholder="Resume name…"
          style={{ width: '100%', fontSize: 13, padding: '8px 10px', border: '0.5px solid var(--primary)', borderRadius: 6, outline: 'none', boxSizing: 'border-box', color: 'var(--text)', background: 'var(--bg)' }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <Btn small variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn small variant="primary" onClick={() => { if (name.trim()) onCreate(name.trim()) }} disabled={!name.trim()}>Create</Btn>
        </div>
      </div>
    </div>
  )
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
          <Btn small variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn small variant="primary" onClick={() => { if (name.trim()) onCreate({ name: name.trim(), color, icon: icon.trim() || null }) }} disabled={!name.trim()}>Create</Btn>
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
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--c-danger)' }}>Resume is too sparse — {Math.round(fit.ratio * 100)}% of a page</div>
                <div style={{ fontSize: 11, color: 'var(--c-danger)', opacity: 0.75, marginTop: 2 }}>Add more experience bullets, skills, or expand your summary to fill the page</div>
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
          style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 12px', fontSize: 12, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer' }}
          onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-secondary)')}
          onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.background = 'none')}>
          + Custom Section…
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
}: {
  resumes:    ResumeListItem[]
  directions: Direction[]
  selectedId: string | null
  onSelect:   (id: string) => void
}) {
  const { t } = useI18n()
  const [openPopoverId, setOpenPopoverId] = useState<string | null>(null)
  const [popoverJobs,   setPopoverJobs]   = useState<Array<{ id: string; company: string; role: string }>>([])
  const [loadingPop,    setLoadingPop]    = useState(false)
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
      No resumes in this direction yet.
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {resumes.map(r => {
        const dir = directions.find(d => d.id === r.directionId)
        const jobCount = r._count?.finalForJobs ?? 0
        const isSelected = r.id === selectedId
        return (
          <div key={r.id}
            onClick={() => onSelect(r.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px',
              borderRadius: 7, cursor: 'pointer',
              background: isSelected ? 'rgba(79,70,229,0.08)' : 'var(--bg)',
              border: `0.5px solid ${isSelected ? 'var(--primary)' : 'var(--border)'}`,
              transition: 'border-color 0.15s',
            }}>
            {/* Icon */}
            <span style={{ fontSize: 16 }}>📄</span>

            {/* Name + direction */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.name}
              </div>
              {dir && (
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>
                  <span style={{ background: dir.color ?? 'var(--bg-secondary)', color: dir.color ? '#fff' : 'var(--text-muted)', borderRadius: 8, padding: '1px 6px', fontSize: 9 }}>
                    {dir.icon ? `${dir.icon} ` : ''}{dir.name}
                  </span>
                </div>
              )}
            </div>

            {/* Badges */}
            <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
              {r.kind === 'base' && (
                <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 8, background: 'rgba(5,150,105,0.10)', color: 'var(--c-success)', border: '0.5px solid rgba(5,150,105,0.30)', fontWeight: 500 }}>{t('resume.lineage.base')}</span>
              )}
              {r.kind === 'adapted' && (
                <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 8, background: 'rgba(217,119,6,0.10)', color: 'var(--c-warning)', border: '0.5px solid rgba(217,119,6,0.30)', fontWeight: 500 }}>{t('resume.lineage.adapted')}</span>
              )}
              {jobCount > 0 && (
                <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 8, background: 'rgba(79,70,229,0.10)', color: 'var(--primary)', border: '0.5px solid rgba(79,70,229,0.30)', fontWeight: 500 }}>⭐ {t('resume.lineage.final')}</span>
              )}
              {r.isDefault && (
                <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 8, background: 'rgba(79,70,229,0.10)', color: 'var(--primary)', border: '0.5px solid rgba(79,70,229,0.30)', fontWeight: 500 }}>Default</span>
              )}
            </div>

            {/* Used by N jobs popover trigger */}
            {jobCount > 0 && (
              <div ref={openPopoverId === r.id ? popoverRef : undefined}
                style={{ position: 'relative', flexShrink: 0 }}
                onClick={e => { e.stopPropagation(); openUsedByPopover(r.id) }}>
                <span style={{ fontSize: 10, color: 'var(--primary)', cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted' }}>
                  {t('resume.lineage.usedBy').replace('{n}', String(jobCount)).replace('{s}', jobCount !== 1 ? 's' : '')}
                </span>
                {openPopoverId === r.id && (
                  <div style={{
                    position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 50,
                    background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 8,
                    boxShadow: '0 4px 16px rgba(0,0,0,0.12)', padding: 8, minWidth: 180, maxWidth: 260,
                  }}>
                    <div style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6 }}>{t('resume.lineage.usedByTitle')}</div>
                    {loadingPop ? (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Loading…</div>
                    ) : popoverJobs.length === 0 ? (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>No jobs found</div>
                    ) : (
                      popoverJobs.map(j => (
                        <div key={j.id} style={{ fontSize: 11, padding: '3px 0', color: 'var(--text)', borderBottom: '0.5px solid var(--border)' }}>
                          {j.company} · {j.role}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── ResumePage ────────────────────────────────────────────────────────────────

export function ResumePage() {
  const toast = useToast()
  const [confirm, ConfirmDialog] = useConfirm()
  const { t } = useI18n()

  const { data: resumeList, loading: loadingList } = useApi<ResumeListItem[]>('/api/resume')
  const [resumes,          setResumes]          = useState<ResumeListItem[]>([])
  const [selectedResumeId, setSelectedResumeId] = useState<string | null>(null)

  const { data: directionList, refetch: refetchDirections } = useApi<Direction[]>('/api/directions')
  const [directions,       setDirections]       = useState<Direction[]>([])
  const [selectedDirId,    setSelectedDirId]    = useState<string | null>(null)
  const [showAddDirection, setShowAddDirection] = useState(false)
  const [editingDirId,     setEditingDirId]     = useState<string | null>(null)

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

  const cache = loadCache()
  const [selectedJobId, setSelectedJobId] = useState<string | null>(cache?.jobId ?? null)
  const [scoreResult, setScoreResult] = useState<ScoreResult | null>(cache?.score ?? null)
  const [suggestions, setSuggestions] = useState<Suggestion[]>(cache?.suggs ?? [])
  const [scoring,     setScoring]     = useState(false)
  const [suggesting,  setSuggesting]  = useState(false)
  // Tracks which jobId the current analysis belongs to — used to skip redundant re-runs
  // after tab navigation (component remount) when cache has already been restored.
  const analysisJobIdRef  = useRef<string | null>(cache?.jobId ?? null)
  // True only on the very first resume load (initial mount / tab-remount).
  // Prevents the selectedResumeId effect from wiping cached analysis on remount.
  const isFirstResumeLoad = useRef(true)
  // True when resume content has changed since the last completed analysis.
  // Drives the "Resume updated — re-analyze?" banner in AiPanel.
  const [contentChangedSinceAnalysis, setContentChangedSinceAnalysis] = useState(false)
  // Monotonically increasing counter — incremented on each runAnalysis call.
  // Responses from superseded calls are silently discarded (race-condition guard).
  const analysisEpochRef = useRef(0)

  const [showTemplates,   setShowTemplates]   = useState(false)
  const [showCoverLetter, setShowCoverLetter] = useState(false)
  const [showNewResume,   setShowNewResume]   = useState(false)
  const [showUploadModal,   setShowUploadModal]   = useState(false)
  const [showIntakeDialog,  setShowIntakeDialog]  = useState(false)
  const [creatingResume,  setCreatingResume]  = useState(false)
  const [showAddSection,  setShowAddSection]  = useState(false)
  const [showVersions,    setShowVersions]    = useState(false)
  const [versions,        setVersions]        = useState<Array<{ id: string; name: string; createdAt: string }>>([])
  const [loadingVers,     setLoadingVers]     = useState(false)
  const [restoring,       setRestoring]       = useState(false)

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
    if (!selectedResumeId) return
    setLoadingCont(true); setDirty(false); setContentChangedSinceAnalysis(false)
    if (!isFirstResumeLoad.current) {
      // User actively switched to a different resume — clear stale analysis
      setScoreResult(null); setSuggestions([])
      analysisJobIdRef.current = null
    } else if (cache?.resumeId && cache.resumeId !== selectedResumeId) {
      // Cache was written for a different resume — don't show its results here
      setScoreResult(null); setSuggestions([])
      analysisJobIdRef.current = null
    }
    isFirstResumeLoad.current = false
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
    // Skip if we already have analysis results for this exact job (e.g. restored from
    // cache after tab navigation). The user can still force a re-run via the ↻ button.
    if (scoreResult && analysisJobIdRef.current === selectedJobId) return
    runAnalysis(content, selectedJobId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJobId, jobs])

  const [flashField, setFlashField] = useState('')

  function triggerFlash(fieldKey: string) {
    setFlashField(fieldKey)
    setTimeout(() => setFlashField(''), 2200)
  }

  function patch(updater: (prev: ResumeContent) => ResumeContent, fieldKey?: string) {
    setContent(prev => {
      if (!prev) return prev
      setDirty(true)
      return updater(prev)
    })
    setContentChangedSinceAnalysis(true)
    if (fieldKey) triggerFlash(fieldKey)
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
    // Epoch guard: if a newer analysis starts before this one finishes, discard this result
    const epoch = ++analysisEpochRef.current
    setScoring(true); setSuggesting(true)
    const [scoreRes, suggestRes] = await Promise.allSettled([
      apiMutate<ScoreResult>('/api/ai/score', 'POST', { resumeContent: c, jobTitle: job.role, jobCompany: job.company, jobDescription: job.description ?? undefined }),
      apiMutate<{ suggestions: Suggestion[] }>('/api/ai/suggest', 'POST', { resumeContent: c, jobTitle: job.role, jobCompany: job.company, jobDescription: job.description ?? undefined }),
    ])
    // A newer analysis was started — silently drop this (stale) response
    if (analysisEpochRef.current !== epoch) return
    setScoring(false); setSuggesting(false)
    if (scoreRes.status === 'fulfilled' && scoreRes.value.data) {
      setScoreResult(scoreRes.value.data)
      analysisJobIdRef.current = jobId
      setContentChangedSinceAnalysis(false)  // analysis is now up-to-date
    } else { const msg = scoreRes.status === 'fulfilled' ? (scoreRes.value.error ?? 'Unknown') : scoreRes.reason; toast.error('Analysis failed', typeof msg === 'string' ? msg : 'Check ANTHROPIC_API_KEY') }
    if (suggestRes.status === 'fulfilled' && suggestRes.value.data?.suggestions) {
      setSuggestions(suggestRes.value.data.suggestions)
    }
    // Persist to localStorage — include resumeId so cache is resume-scoped
    if (scoreRes.status === 'fulfilled' && scoreRes.value.data) {
      try {
        const latestJob = jobs.find(j => j.id === selectedJobId)
        saveCache({
          resumeId: selectedResumeId,
          jobId: selectedJobId,
          jobTitle: latestJob?.role ?? '',
          jobCompany: latestJob?.company ?? '',
          score: scoreRes.value.data,
          suggs: suggestRes.status === 'fulfilled' ? (suggestRes.value.data?.suggestions ?? []) : [],
        })
      } catch {}
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
  const pendingSaveRef        = useRef(false) // new edits arrived while saving

  useEffect(() => { latestContent.current         = content },         [content])
  useEffect(() => { latestSectionOrder.current    = sectionOrder },    [sectionOrder])
  useEffect(() => { latestTemplateId.current      = templateId },      [templateId])
  useEffect(() => { latestTemplateOptions.current = templateOptions }, [templateOptions])
  useEffect(() => { latestResumeName.current      = resumeName },      [resumeName])
  useEffect(() => { latestSelectedJobId.current   = selectedJobId },   [selectedJobId])

  async function handleSave() {
    if (!selectedResumeId || !latestContent.current) return
    if (isSavingRef.current) { pendingSaveRef.current = true; return }

    isSavingRef.current = true
    setSaving(true)
    const snapshot = {
      name:            latestResumeName.current,
      content:         { ...latestContent.current, sectionOrder: latestSectionOrder.current },
      templateId:      latestTemplateId.current,
      templateOptions: latestTemplateOptions.current,
    }
    const { error } = await apiMutate(`/api/resume/${selectedResumeId}`, 'PATCH', snapshot)
    isSavingRef.current = false
    setSaving(false)

    if (error) {
      toast.error('Save failed', error)
    } else {
      setDirty(false)
      toast.success('Saved', 'Resume updated successfully')
      // Re-analysis is intentionally NOT triggered here — the AiPanel stale indicator
      // prompts the user to re-analyse when ready, avoiding a token burn on every save.
      // If new edits arrived while we were saving, save again immediately
      if (pendingSaveRef.current) { pendingSaveRef.current = false; handleSave() }
    }
  }

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
      setContent(imported)
      setSectionOrder(imported.sectionOrder ?? DEFAULT_ORDER)
      setDirty(true)
      setContentChangedSinceAnalysis(true)
      toast.success('Resume imported', 'Review the content and save when ready')
    } else {
      // Create a new resume with the imported content
      const name = imported.contact.name ? `${imported.contact.name}'s Resume` : 'Imported Resume'
      setCreatingResume(true)
      const { data, error } = await apiMutate<Resume>('/api/resume', 'POST', { name, content: imported, isDefault: false })
      setCreatingResume(false)
      if (data) {
        const item: ResumeListItem = { id: data.id, name: data.name, isDefault: data.isDefault, directionId: null, kind: 'base' as const, parentResumeId: null, targetJobId: null, origin: 'manual' as const, basicsDetached: false, createdAt: data.createdAt, updatedAt: data.updatedAt }
        setResumes(prev => [...prev, item])
        setSelectedResumeId(data.id)
        toast.success('Resume imported', `"${name}" created`)
      } else toast.error('Import failed', error ?? 'Could not create resume')
    }
  }

  async function handleCreateResume(name: string) {
    setCreatingResume(true); setShowNewResume(false)
    const { data, error } = await apiMutate<Resume>('/api/resume', 'POST', { name, content: EMPTY_CONTENT, isDefault: false })
    setCreatingResume(false)
    if (data) {
      const item: ResumeListItem = { id: data.id, name: data.name, isDefault: data.isDefault, directionId: null, kind: 'base' as const, parentResumeId: null, targetJobId: null, origin: 'manual' as const, basicsDetached: false, createdAt: data.createdAt, updatedAt: data.updatedAt }
      setResumes(prev => [...prev, item]); setSelectedResumeId(data.id)
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
    if (!selectedResumeId) return
    setRestoring(true)
    const { data, error } = await apiMutate<Resume>(`/api/resume/${selectedResumeId}/versions`, 'POST', { versionId })
    setRestoring(false)
    if (error || !data) { toast.error('Restore failed', error ?? 'Could not restore version'); return }
    setContent(data.content as ResumeContent)
    setResumeName(data.name)
    setTemplateId(data.templateId ?? 'clean')
    setTemplateOptions((data.templateOptions as TemplateOptions) ?? {})
    setShowVersions(false)
    setDirty(true)
    setContentChangedSinceAnalysis(true)
    toast.success('Version restored', 'Previous version loaded. Save to keep it.')
  }

  // Apply a keyword/item to the correct section (not just skills)
  function applyTargeted(t: { type: string; section: string; keyword: string; value?: string }) {
    const { section, keyword } = t

    switch (section) {
      case 'summary':
        // Append keyword context to summary
        patch(p => {
          const current = p.summary ?? ''
          const addition = current ? ` ${keyword}.` : keyword
          return { ...p, summary: current + addition }
        }, 'summary')
        triggerFlash('summary')
        toast.success('Summary updated', `Added "${keyword}" context`)
        break

      case 'skills':
        setContent(prev => {
          if (!prev) return prev
          const existing = new Set(prev.skills?.map(s => s.toLowerCase()) ?? [])
          if (existing.has(keyword.toLowerCase())) return prev
          return { ...prev, skills: [...(prev.skills ?? []), keyword] }
        })
        triggerFlash('skills')
        toast.success('Skill added', `"${keyword}" added to Skills`)
        break

      case 'experience':
      case 'projects':
        toast.success('Tip noted', `"${keyword}" — add this to your ${section} section`)
        break

      default:
        setContent(prev => {
          if (!prev) return prev
          const existing = new Set(prev.skills?.map(s => s.toLowerCase()) ?? [])
          if (existing.has(keyword.toLowerCase())) return prev
          return { ...prev, skills: [...(prev.skills ?? []), keyword] }
        })
        triggerFlash('skills')
        toast.success('Added', `"${keyword}" added`)
    }
  }

  function applySuggestion(i: number) {
    const s = suggestions[i]
    if (!s) return
    setSuggestions(prev => { const n = [...prev]; n[i] = { ...n[i], applied: true }; return n })
    setDirty(true)

    const hasProposed = s.proposed && s.proposed.trim()

    switch (s.target) {
      case 'summary':
        if (s.action === 'rewrite' && hasProposed) {
          patch(p => ({ ...p, summary: s.proposed! }), 'summary')
          toast.success('Summary updated', 'AI-rewritten summary applied')
        } else { toast.success('Noted', 'Suggestion marked as applied') }
        break

      case 'skills':
        if (s.action === 'reorder' && hasProposed) {
          const reordered = s.proposed!.split(/[,;]\s*/).map(x => x.trim()).filter(Boolean)
          if (reordered.length > 0) {
            patch(p => ({ ...p, skills: reordered }), 'skills')
            toast.success('Skills reordered', `${reordered.length} skills reorganised for ATS`)
          }
        } else if (s.action === 'add_keywords' && scoreResult?.missingItems?.length) {
          // Add ALL section-targeted missing keywords
          const skillsKw = scoreResult.missingItems.filter(m => m.target === 'skills').map(m => m.keyword)
          if (skillsKw.length > 0) {
            setContent(prev => {
              if (!prev) return prev
              const existing = new Set(prev.skills?.map(sk => sk.toLowerCase()) ?? [])
              const added = skillsKw.filter(kw => !existing.has(kw.toLowerCase()))
              if (added.length === 0) return prev
              return { ...prev, skills: [...(prev.skills ?? []), ...added] }
            })
            setContentChangedSinceAnalysis(true)
            triggerFlash('skills')
            toast.success('Skills updated', `Added ${skillsKw.length} targeted keyword(s)`)
          }
          // Also toast for non-skills keywords
          const otherKw = scoreResult.missingItems.filter(m => m.target !== 'skills')
          if (otherKw.length > 0) {
            toast.success('Review other gaps', `Also check: ${otherKw.map(m => m.keyword).join(', ')}`)
          }
        } else { toast.success('Noted', 'Suggestion marked as applied') }
        break

      case 'experience':
        if (s.action === 'enhance' && hasProposed) {
          toast.success('Experience tip', 'Open the Experience section and use ✦ AI suggest on a bullet to apply enhancements')
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

  // ── Direction filter ──────────────────────────────────────────────────────

  const filteredResumes = selectedDirId
    ? resumes.filter(r => r.directionId === selectedDirId)
    : resumes

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

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <ConfirmDialog />
      <TopBar title="Resume">
        {/* Direction chips */}
        <div style={{ display: 'flex', gap: 4, overflowX: 'auto', flexShrink: 0, maxWidth: 320, alignItems: 'center' }}>
          <button
            onClick={() => setSelectedDirId(null)}
            style={{
              fontSize: 10, padding: '3px 8px', borderRadius: 10, border: '0.5px solid var(--border)',
              background: selectedDirId === null ? 'var(--primary)' : 'var(--bg)',
              color: selectedDirId === null ? '#fff' : 'var(--text)',
              cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
            }}>All</button>
          {directions.map(d => (
            <div key={d.id} style={{ position: 'relative', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}>
              {editingDirId === d.id ? (
                <input
                  autoFocus
                  defaultValue={d.name}
                  onBlur={async (e) => {
                    const newName = e.currentTarget.value.trim()
                    setEditingDirId(null)
                    if (!newName || newName === d.name) return
                    const { data, error } = await apiMutate<Direction>(`/api/directions/${d.id}`, 'PATCH', { name: newName })
                    if (data) setDirections(prev => prev.map(x => x.id === d.id ? data : x))
                    else toast.error('Rename failed', error ?? 'Could not rename direction')
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                    if (e.key === 'Escape') setEditingDirId(null)
                  }}
                  style={{ fontSize: 10, padding: '2px 6px', borderRadius: 10, border: '1px solid var(--primary)', outline: 'none', width: 120, background: 'var(--bg)', color: 'var(--text)' }}
                />
              ) : (
                <button
                  onClick={() => setSelectedDirId(d.id === selectedDirId ? null : d.id)}
                  style={{
                    fontSize: 10, padding: '3px 8px', borderRadius: 10, border: `0.5px solid ${d.color ?? 'var(--border)'}`,
                    background: selectedDirId === d.id ? (d.color ?? 'var(--primary)') : 'var(--bg)',
                    color: selectedDirId === d.id ? '#fff' : 'var(--text)',
                    cursor: 'pointer', whiteSpace: 'nowrap',
                  }}>
                  {d.icon ? `${d.icon} ` : ''}{d.name}
                </button>
              )}
              <div style={{ display: 'inline-flex', gap: 1, marginLeft: 1 }}>
                <button
                  onClick={() => setEditingDirId(d.id)}
                  title="Rename"
                  style={{ fontSize: 9, padding: '1px 3px', border: '0.5px solid var(--border)', borderRadius: 4, background: 'var(--bg)', color: 'var(--text-muted)', cursor: 'pointer', lineHeight: 1 }}>✎</button>
                <button
                  onClick={async () => {
                    const ok = await confirm({ title: 'Delete direction?', message: `"${d.name}" will be unlinked from its resumes. Resumes will not be deleted.`, danger: true, confirmLabel: 'Delete' })
                    if (!ok) return
                    const { error } = await apiMutate(`/api/directions/${d.id}`, 'DELETE')
                    if (error) { toast.error('Delete failed', error); return }
                    setDirections(prev => prev.filter(x => x.id !== d.id))
                    setEditingDirId(null)
                    if (selectedDirId === d.id) setSelectedDirId(null)
                    toast.info('Deleted', `Direction "${d.name}" removed`)
                  }}
                  title="Delete"
                  style={{ fontSize: 9, padding: '1px 3px', border: '0.5px solid var(--border)', borderRadius: 4, background: 'var(--bg)', color: 'var(--c-danger)', cursor: 'pointer', lineHeight: 1 }}>×</button>
              </div>
            </div>
          ))}
          <button
            onClick={() => setShowAddDirection(true)}
            style={{
              fontSize: 10, padding: '3px 8px', borderRadius: 10, border: '0.5px dashed var(--border)',
              background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
            }}>{t('direction.add')}</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <select value={selectedResumeId ?? ''} onChange={async e => {
            const next = e.target.value
            if (dirty) {
              const ok = await confirm({ title: 'Discard changes?', message: 'You have unsaved changes. Switching will discard them.', danger: true, confirmLabel: 'Discard' })
              if (!ok) return
            }
            setSelectedResumeId(next)
          }} style={{ fontSize: 11, padding: '4px 8px', border: '0.5px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)', outline: 'none', maxWidth: 160 }}>
            {filteredResumes.map(r => (
              <option key={r.id} value={r.id}>
                {r.isDefault ? '★ ' : ''}{r.name}{r.kind === 'adapted' ? ' (Adapted)' : ''}
              </option>
            ))}
          </select>
          <button onClick={() => setShowNewResume(true)} disabled={creatingResume} title="New resume"
            style={{ fontSize: 13, lineHeight: 1, padding: '3px 7px', border: '0.5px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--primary)', cursor: 'pointer' }}>
            {creatingResume ? '…' : '+'}
          </button>
          <button onClick={() => setShowIntakeDialog(true)} title="Import resume via upload, paste or screenshot"
            style={{ fontSize: 11, lineHeight: 1, padding: '3px 8px', border: '0.5px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--primary)', cursor: 'pointer' }}>
            ↑ Intake
          </button>
          <button
            title="Delete this resume"
            disabled={resumes.length <= 1}
            onClick={async () => {
              if (!selectedResumeId) return
              const name = resumes.find(r => r.id === selectedResumeId)?.name ?? 'this resume'
              const ok = await confirm({
                title: 'Delete resume?',
                message: `"${name}" will be permanently deleted. This cannot be undone.`,
                danger: true,
                confirmLabel: 'Delete',
              })
              if (!ok) return
              const { error } = await apiMutate(`/api/resume/${selectedResumeId}`, 'DELETE', undefined)
              if (error) { toast.error('Delete failed', error); return }
              const remaining = resumes.filter(r => r.id !== selectedResumeId)
              setResumes(remaining)
              setSelectedResumeId(remaining[0]?.id ?? null)
              toast.info('Deleted', `"${name}" has been removed`)
            }}
            style={{
              fontSize: 13, lineHeight: 1, padding: '3px 7px',
              border: '0.5px solid var(--border)', borderRadius: 6,
              background: 'var(--bg)', cursor: resumes.length <= 1 ? 'not-allowed' : 'pointer',
              color: resumes.length <= 1 ? 'var(--text-muted)' : 'var(--c-danger)',
              opacity: resumes.length <= 1 ? 0.4 : 1,
            }}>
            ✕
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
          if (!selectedResumeId || !content) { toast.info('Select a resume first'); return }
          // Snapshot current state into localStorage — print page reads this directly,
          // so PDF always reflects what the user sees regardless of save timing
          const snapshot = {
            content: { ...content, sectionOrder },
            templateId, templateOptions, name: resumeName,
            ts: Date.now(),
          }
          localStorage.setItem(`print:${selectedResumeId}`, JSON.stringify(snapshot))
          // Also persist to DB in the background (non-blocking)
          if (dirty) handleSave()
          window.open(`/resume/${selectedResumeId}/print`, '_blank')
        }}>↓ PDF</Btn>
        <Btn variant="ghost" onClick={() => { if (!selectedResumeId) { toast.info('Select a resume first'); return }; fetchVersions(); setShowVersions(true) }}>🕐 History</Btn>
        <Btn variant="primary" onClick={handleSave} disabled={!dirty || saving}>
          {saving ? 'Saving…' : dirty ? 'Save*' : 'Saved'}
        </Btn>
      </TopBar>

      {loadingCont ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-tertiary)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 28, height: 28, border: '2.5px solid rgba(79,70,229,0.20)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
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
            {/* Empty-state banner: no directions set up */}
            {directions.length === 0 && (
              <div style={{ padding: '8px 12px', background: 'rgba(217,119,6,0.06)', border: '0.5px solid rgba(217,119,6,0.20)', borderRadius: 7, marginBottom: 12, fontSize: 11, color: 'var(--c-warning)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>Looks like you haven&apos;t set up your directions yet.</span>
                <button
                  onClick={() => toast.info('Setup', 'Go to Settings → Profile to restart onboarding')}
                  style={{ fontSize: 10, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
                >
                  Start setup
                </button>
              </div>
            )}
            {/* Resume Library Panel */}
            {resumes.length > 1 && (
              <div style={{ marginBottom: 16, padding: '10px 12px', background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 8, letterSpacing: '0.05em' }}>RESUME LIBRARY</div>
                <ResumeLibraryPanel
                  resumes={filteredResumes}
                  directions={directions}
                  selectedId={selectedResumeId}
                  onSelect={async (id) => {
                    if (dirty) {
                      const ok = await confirm({ title: 'Discard changes?', message: 'You have unsaved changes. Switching will discard them.', danger: true, confirmLabel: 'Discard' })
                      if (!ok) return
                    }
                    setSelectedResumeId(id)
                  }}
                />
              </div>
            )}
            {/* ── PREVIEW MODE ── */}
            {previewMode && <ResumePreview content={{ ...content, sectionOrder }} templateId={templateId} templateOptions={templateOptions} />}
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
              <span style={{ fontSize: 10, color: dirty ? 'var(--c-warning)' : 'var(--text-muted)' }}>
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
                  style={{ fontSize: 11, color: 'var(--primary)', background: 'rgba(79,70,229,0.06)', border: '0.5px dashed rgba(79,70,229,0.30)', borderRadius: 6, padding: '6px 20px', cursor: 'pointer' }}>
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
            onAddKeyword={kw => patch(p => ({ ...p, skills: [...(p.skills ?? []), kw] }), 'skills')}
            onApplyTargeted={applyTargeted}
            onEditSection={sec => setEditSection(sec)}
            currentSummary={content?.summary}
            currentSkills={content?.skills}
            contentChangedSinceAnalysis={contentChangedSinceAnalysis}
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
        <CoverLetterPanel
          job={selectedJob}
          resumeContent={content}
          resumeName={resumeName}
          templateName={templateId}
          onClose={() => setShowCoverLetter(false)}
        />
      )}
      {showVersions && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) setShowVersions(false) }}>
          <div style={{ background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 10, padding: 20, width: 400, maxHeight: '70vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.15)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <span style={{ fontSize: 14, fontWeight: 500 }}>Version History</span>
              <button onClick={() => setShowVersions(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'var(--text-muted)', lineHeight: 1, padding: 0 }}>✕</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {loadingVers ? (
                <div style={{ textAlign: 'center', padding: 30, fontSize: 12, color: 'var(--text-muted)' }}>Loading versions…</div>
              ) : versions.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 30 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>No versions yet</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Versions are created automatically when you save your resume.</div>
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
      {showUploadModal && (
        <UploadResumeModal onClose={() => setShowUploadModal(false)} onImport={handleImportResume} />
      )}
      {showIntakeDialog && (
        <ResumeIntakeDialog
          onClose={() => setShowIntakeDialog(false)}
          onSaved={(resume) => {
            const item: ResumeListItem = {
              id: resume.id, name: resume.name, isDefault: resume.isDefault,
              directionId: resume.directionId, kind: resume.kind,
              parentResumeId: resume.parentResumeId, targetJobId: resume.targetJobId,
              origin: resume.origin, basicsDetached: resume.basicsDetached,
              createdAt: resume.createdAt, updatedAt: resume.updatedAt,
            }
            setResumes(prev => [...prev, item])
            setSelectedResumeId(resume.id)
            toast.success('Resume saved', `"${resume.name}" added to your library`)
            setShowIntakeDialog(false)
          }}
          directions={directions}
          initialDirId={selectedDirId}
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
