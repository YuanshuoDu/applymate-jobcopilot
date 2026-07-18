'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, FileCheck2, FileText, Link2, LoaderCircle, Sparkles, X } from 'lucide-react'
import type { Job } from '@/lib/types'

type ReadinessItem = {
  id: 'suggestions' | 'template' | 'cover-letter' | 'job' | 'copy'
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
  onClose: () => void
  onReviewSuggestions: () => void
  onCreateCoverLetter: () => void
  onLinkJob: () => void
  onConfirm: () => Promise<boolean>
  onDownload: () => Promise<void>
}

const icons = {
  suggestions: Sparkles,
  template: FileText,
  'cover-letter': FileCheck2,
  job: Link2,
  copy: FileCheck2,
}

export function FinalConfirmDialog({
  job, resumeName, templateName, pendingSuggestions, isDirty, packReady,
  onClose, onReviewSuggestions, onCreateCoverLetter, onLinkJob, onConfirm, onDownload,
}: Props) {
  const items = useMemo<ReadinessItem[]>(() => [
    {
      id: 'suggestions',
      label: 'Checking AI suggestions',
      detail: pendingSuggestions ? `${pendingSuggestions} suggestion${pendingSuggestions === 1 ? '' : 's'} still need review` : 'All applicable suggestions are applied',
      complete: pendingSuggestions === 0,
      action: pendingSuggestions ? 'Review' : undefined,
    },
    {
      id: 'template',
      label: 'Verifying template',
      detail: `${templateName} template is applied`,
      complete: Boolean(templateName),
    },
    {
      id: 'cover-letter',
      label: 'Checking cover letter (optional)',
      detail: job?.finalCoverLetterId ? 'A final cover letter is linked to this role' : job ? 'Optional — create one if this application asks for it' : 'Optional — link a job to create one for this role',
      // A cover letter is useful but not required to make a resume application-ready.
      complete: true,
      action: job && !job.finalCoverLetterId ? 'Create now' : undefined,
    },
    {
      id: 'job',
      label: 'Confirming saved job link',
      detail: job ? `${job.company} · ${job.role}` : 'This resume is not linked to My Jobs yet',
      complete: Boolean(job),
      action: job ? undefined : 'Link job',
    },
    {
      id: 'copy',
      label: 'Preparing application-ready copy',
      detail: packReady ? 'PDF application pack is ready to download' : isDirty ? 'Save the latest edits before finalising' : 'It will be generated only after you confirm',
      complete: packReady,
      blocking: false,
    },
  ], [isDirty, job, packReady, pendingSuggestions, templateName])

  const [checkedCount, setCheckedCount] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const [confirmed, setConfirmed] = useState(packReady)

  useEffect(() => {
    setCheckedCount(0)
    const timers = items.map((_, index) => window.setTimeout(() => setCheckedCount(index + 1), 230 + index * 360))
    return () => timers.forEach(window.clearTimeout)
  }, [items.length])

  useEffect(() => setConfirmed(packReady), [packReady])

  const unresolved = items.filter(item => !item.complete && item.blocking !== false)
  const ready = checkedCount === items.length && unresolved.length === 0

  async function handleConfirm() {
    setConfirming(true)
    const success = await onConfirm()
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
        <button className="final-confirm-close" onClick={onClose} aria-label="Close final confirmation"><X size={18} /></button>
        <div className="final-confirm-heading">
          <span className="final-confirm-shield"><Check size={17} /></span>
          <div>
            <h2 id="final-confirm-title">Final confirm</h2>
            <p>We&apos;ll run a final check before creating your application-ready PDF.</p>
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
                {checked && !item.action && <span className="final-confirm-status">{item.complete ? 'Completed' : item.blocking === false ? 'After confirm' : 'Needs review'}</span>}
              </div>
            )
          })}
        </div>

        {job && <div className="final-confirm-job">
          <Link2 size={16} />
          <div><strong>{job.role}</strong><span>{job.company} · Linked in My Jobs</span></div>
        </div>}

        <div className="final-confirm-footer">
          {confirmed ? <>
            <div className="final-confirm-ready"><Check size={15} /> Application pack confirmed</div>
            <button className="final-confirm-primary" onClick={() => void onDownload()}><FileCheck2 size={16} /> Download application pack</button>
          </> : <>
            <button className="final-confirm-secondary" onClick={onClose}>Back to edit</button>
            <button className="final-confirm-primary" disabled={!ready || confirming} onClick={() => void handleConfirm()}>
              {confirming ? <LoaderCircle size={16} /> : <Check size={16} />}
              {confirming ? 'Confirming…' : 'Confirm & mark ready'}
            </button>
          </>}
        </div>
        {!confirmed && <p className="final-confirm-note">A confirmed copy is available to the writer agent and can be exported as PDF whenever you&apos;re ready to apply.</p>}
        <span className="final-confirm-resume-name">{resumeName}</span>
      </section>
    </div>
  )
}
