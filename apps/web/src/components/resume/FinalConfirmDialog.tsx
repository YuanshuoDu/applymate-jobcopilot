'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, FileCheck2, FileText, Link2, LoaderCircle, Sparkles, X } from 'lucide-react'
import { ResumeRenderer } from '@/components/resume/ResumeRenderer'
import type { ApplicationAudit, Job, ResumeContent, TemplateOptions } from '@/lib/types'
import { useI18n } from '@/lib/i18n'

type ReadinessItem = {
  id: 'suggestions' | 'template' | 'cover-letter' | 'job' | 'audit' | 'copy'
  label: string
  detail: string
  complete: boolean
  blocking?: boolean
  action?: string
}

type Props = {
  job: Job | null
  resumeName: string
  templateName: string
  pendingSuggestions: number
  isDirty: boolean
  packReady: boolean
  resumeContent: ResumeContent
  templateId: string
  templateOptions: TemplateOptions
  coverLetterContent: string | null
  onClose: () => void
  onReviewSuggestions: () => void
  onCreateCoverLetter: () => void
  onLinkJob: () => void
  onAudit: () => Promise<ApplicationAudit | null>
  onConfirm: (audit: ApplicationAudit) => Promise<boolean>
  onDownload: () => Promise<void>
  exportedPackFolder: string | null
}

const icons = {
  suggestions: Sparkles,
  template: FileText,
  'cover-letter': FileCheck2,
  job: Link2,
  audit: FileCheck2,
  copy: FileCheck2,
}

export function FinalConfirmDialog({
  job, resumeName, templateName, pendingSuggestions, isDirty, packReady, resumeContent, templateId, templateOptions, coverLetterContent,
  onClose, onReviewSuggestions, onCreateCoverLetter, onLinkJob, onAudit, onConfirm, onDownload, exportedPackFolder,
}: Props) {
  const { t } = useI18n()
  const [audit, setAudit] = useState<ApplicationAudit | null>(null)
  const items = useMemo<ReadinessItem[]>(() => [
    {
      id: 'suggestions',
      label: t('resume.checkingAiSuggestions'),
      detail: pendingSuggestions ? `${pendingSuggestions} ${t(pendingSuggestions === 1 ? 'resume.suggestion' : 'resume.suggestions')} ${t('resume.stillNeedReview')}` : t('resume.allSuggestionsApplied'),
      complete: pendingSuggestions === 0,
      action: pendingSuggestions ? t('common.review') : undefined,
    },
    {
      id: 'template',
      label: t('resume.verifyingTemplate'),
      detail: `${templateName} ${t('resume.templateApplied')}`,
      complete: Boolean(templateName),
    },
    {
      id: 'cover-letter',
      label: t('resume.checkingCoverLetter'),
      detail: coverLetterContent ? t('resume.coverLetterLinked') : job ? t('resume.selectCoverLetter') : t('resume.linkJobForCoverLetter'),
      complete: Boolean(coverLetterContent),
      action: job && !coverLetterContent ? t('resume.createNow') : undefined,
    },
    {
      id: 'audit',
      label: t('resume.independentAudit'),
      detail: audit ? audit.summary : t('resume.auditComparison'),
      complete: audit?.verdict === 'pass',
      blocking: true,
    },
    {
      id: 'job',
      label: t('resume.confirmingJobLink'),
      detail: job ? `${job.company} · ${job.role}` : t('resume.notLinkedToJobs'),
      complete: Boolean(job),
      action: job ? undefined : t('resume.linkJob'),
    },
    {
      id: 'copy',
      label: t('resume.preparingApplicationCopy'),
      detail: packReady ? t('resume.pdfPackReady') : isDirty ? t('resume.saveLatestEdits') : t('resume.generatedAfterConfirm'),
      complete: packReady,
      blocking: false,
    },
  ], [audit, coverLetterContent, isDirty, job, packReady, pendingSuggestions, templateName, t])

  const [checkedCount, setCheckedCount] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const [confirmed, setConfirmed] = useState(packReady)

  useEffect(() => {
    setCheckedCount(0)
    const timers = items.map((_, index) => window.setTimeout(() => setCheckedCount(index + 1), 230 + index * 360))
    return () => timers.forEach(window.clearTimeout)
  }, [items.length])

  useEffect(() => setConfirmed(packReady), [packReady])

  const unresolvedBeforeAudit = items.filter(item => item.id !== 'audit' && !item.complete && item.blocking !== false)
  const ready = checkedCount === items.length && unresolvedBeforeAudit.length === 0

  async function handleConfirm() {
    setConfirming(true)
    const nextAudit = await onAudit()
    setAudit(nextAudit)
    if (!nextAudit || nextAudit.verdict !== 'pass') {
      setConfirming(false)
      return
    }
    const success = await onConfirm(nextAudit)
    setConfirming(false)
    if (success) setConfirmed(true)
  }

  function runAction(item: ReadinessItem) {
    if (item.id === 'suggestions') onReviewSuggestions()
    if (item.id === 'cover-letter') onCreateCoverLetter()
    if (item.id === 'job') onLinkJob()
  }

  return (
    <div className="final-confirm-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section className="final-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="final-confirm-title">
        <button className="final-confirm-close" onClick={onClose} aria-label={t('resume.closeFinalConfirmation')}><X size={18} /></button>
        <div className="final-confirm-heading">
          <span className="final-confirm-shield"><Check size={17} /></span>
          <div>
            <h2 id="final-confirm-title">{t('resume.finalConfirm')}</h2>
            <p>{t('resume.finalCheckBeforePdf')}</p>
          </div>
        </div>

        <div className="final-confirm-checks" aria-live="polite">
          {items.map((item, index) => {
            const Icon = icons[item.id]
            const checked = checkedCount > index
            const status = !checked ? 'checking' : item.complete ? 'complete' : 'attention'
            return (
              <div className={`final-confirm-check is-${status}`} key={item.id}>
                <span className="final-confirm-step-icon">
                  {!checked ? <LoaderCircle size={17} /> : item.complete ? <Check size={16} /> : <AlertTriangle size={16} />}
                </span>
                <span className="final-confirm-check-icon"><Icon size={16} /></span>
                <div className="final-confirm-check-copy">
                  <strong>{item.label}</strong>
                  <span>{item.detail}</span>
                </div>
                {checked && item.action && <button onClick={() => runAction(item)}>{item.action}</button>}
                {checked && !item.action && <span className="final-confirm-status">{item.id === 'audit' && confirming ? t('resume.auditing') : item.complete ? t('resume.completed') : item.blocking === false ? t('resume.afterConfirm') : t('resume.needsReview')}</span>}
              </div>
            )
          })}
        </div>

        {job && <div className="final-confirm-job">
          <Link2 size={16} />
          <div><strong>{job.role}</strong><span>{job.company} · {t('resume.linkedInMyJobs')}</span></div>
        </div>}

        <div className="final-confirm-footer">
          {confirmed ? <>
            <div className="final-confirm-ready"><Check size={15} /> {t('resume.applicationPackConfirmed')}</div>
            <button className="final-confirm-primary" onClick={() => void onDownload()}><FileCheck2 size={16} /> {exportedPackFolder ? t('resume.openJobFolder') : t('resume.savePdfs')}</button>
          </> : <>
            <button className="final-confirm-secondary" onClick={onClose}>{t('resume.backToEdit')}</button>
            <button className="final-confirm-primary" disabled={!ready || confirming} onClick={() => void handleConfirm()}>
              {confirming ? <LoaderCircle size={16} /> : <Check size={16} />}
              {confirming ? t('resume.auditingFinal') : audit?.verdict === 'needs_review' || audit?.verdict === 'blocked' ? t('resume.auditAgain') : t('resume.auditConfirmPackage')}
            </button>
          </>}
        </div>
        {audit && audit.verdict !== 'pass' && (
          <div className="final-confirm-audit-results">
            <strong>{audit.verdict === 'blocked' ? t('resume.auditBlocked') : t('resume.auditNeedsReview')}</strong>
            {audit.findings.filter(finding => finding.severity !== 'pass').map((finding, index) => (
              <div key={`${finding.title}-${index}`}><b>{finding.title}</b><span>{finding.evidence} — {finding.action}</span></div>
            ))}
          </div>
        )}
        {confirmed && <div className="final-material-preview">
          <div><strong>{t('resume.finalResume')}</strong><div className="final-material-preview-resume"><ResumeRenderer content={resumeContent} templateId={templateId} templateOptions={templateOptions} scale={0.42} /></div></div>
          <div><strong>{t('resume.finalCoverLetter')}</strong><div className="final-material-preview-letter">{coverLetterContent ?? t('resume.noCoverLetter')}</div></div>
        </div>}
        {!confirmed && <p className="final-confirm-note">{t('resume.confirmedCopyNote')}</p>}
        <span className="final-confirm-resume-name">{resumeName}</span>
      </section>
    </div>
  )
}
