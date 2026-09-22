'use client'

import { Check, Sparkles, X } from 'lucide-react'
import { memo, useMemo } from 'react'
import { useI18n } from '@/lib/i18n'
import { diffResumeText, type DiffChunk, type ResumeChange, type ResumeChangeSection } from '@/lib/resume-change-diff'

const SECTION_LABELS: Record<ResumeChangeSection, string> = {
  contact: 'resume.changeSectionContact',
  summary: 'resume.summary',
  skills: 'resume.skills',
  experience: 'resume.section.experience',
  education: 'resume.section.education',
  languages: 'resume.section.languages',
  projects: 'resume.section.projects',
  certifications: 'resume.section.certifications',
  cover_letter: 'resume.coverLetter',
}

function DiffText({ chunks }: { chunks: DiffChunk[] }) {
  return <span className="resume-change-diff-text">{chunks.map((chunk, index) => {
    if (chunk.type === 'same') return <span key={index}>{chunk.text}</span>
    return <mark key={index} className={`resume-change-diff-token is-${chunk.type}`}>{chunk.text}</mark>
  })}</span>
}

function sourceLabel(source: ResumeChange['source'], t: (key: string) => string) {
  return source === 'audit' ? t('resume.changeSourceAudit') : t('resume.changeSourceAi')
}

const ResumeChangeItem = memo(function ResumeChangeItem({ change, onDismiss, t }: {
  change: ResumeChange
  onDismiss: (id: string) => void
  t: (key: string) => string
}) {
  const diff = useMemo(() => diffResumeText(change.before, change.after), [change.before, change.after])
  return (
    <article className="resume-change-item" data-resume-change-id={change.id}>
      <div className="resume-change-item-heading">
        <span className={`resume-change-source is-${change.source}`}>
          {change.source === 'audit' ? <Check size={10} aria-hidden="true" /> : <Sparkles size={10} aria-hidden="true" />}
          {sourceLabel(change.source, t)}
        </span>
        <strong>{t(SECTION_LABELS[change.section])}</strong>
        <button type="button" onClick={() => onDismiss(change.id)} aria-label={t('resume.changeHide')} title={t('resume.changeHide')}>
          <X size={13} aria-hidden="true" />
        </button>
      </div>
      <div className="resume-change-columns">
        <div className="resume-change-column is-before">
          <span className="resume-change-column-label">{t('resume.changeBefore')}</span>
          <div><DiffText chunks={diff.before} /></div>
        </div>
        <div className="resume-change-column is-after">
          <span className="resume-change-column-label">{t('resume.changeAfter')}</span>
          <div><DiffText chunks={diff.after} /></div>
        </div>
      </div>
    </article>
  )
})

export function ResumeChangeSummary({ changes, onDismiss, onClear }: {
  changes: ResumeChange[]
  onDismiss: (id: string) => void
  onClear: () => void
}) {
  const { t } = useI18n()
  if (changes.length === 0) return null

  return (
    <section className="resume-change-summary" data-resume-change-summary aria-label={t('resume.changesTitle')}>
      <div className="resume-change-summary-heading">
        <span className="resume-change-summary-icon"><Sparkles size={14} aria-hidden="true" /></span>
        <div>
          <strong>{t('resume.changesTitle')}</strong>
          <p>{t('resume.changesHint')}</p>
        </div>
        <button type="button" onClick={onClear} className="resume-change-clear">{t('resume.changeClear')}</button>
      </div>

      <div className="resume-change-list">
        {changes.map(change => <ResumeChangeItem key={change.id} change={change} onDismiss={onDismiss} t={t} />)}
      </div>
    </section>
  )
}
