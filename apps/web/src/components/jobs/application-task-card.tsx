'use client'

import React from 'react'
import { useI18n } from '@/lib/i18n'
import { unknownApplicationSubmissionEvidence } from '@/lib/agent/application-submission-evidence'
import { applicationTaskSessionHref, getApplicationTaskState, type ApplicationTaskView } from './application-task-model'
import { applicationSubmissionEvidenceCopy } from './application-submission-evidence-copy'

const SUBMISSION_CHECKPOINTS = new Set([
  'submission_request_started', 'submission_authorized', 'submission_uncertain', 'submission_verified', 'submission_blocked',
  'execution_interrupted', 'receipt_rejected', 'queue_retry',
])

export function ApplicationTaskCard({ task, onOpenSession }: {
  task: ApplicationTaskView
  onOpenSession?: (sessionId: string) => void
}) {
  const { t, lang } = useI18n()
  const state = getApplicationTaskState(task)
  const href = applicationTaskSessionHref(task)
  const evidenceVisible = task.status === 'submitted' || task.status === 'unknown' || SUBMISSION_CHECKPOINTS.has(task.checkpoint ?? '')
  const submissionEvidence = task.submissionEvidence ?? unknownApplicationSubmissionEvidence(evidenceVisible, 'unknown')
  const evidence = applicationSubmissionEvidenceCopy(submissionEvidence, lang)
  return <section aria-label={`${task.company} · ${task.role}`} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 14, background: 'var(--bg-secondary)', minWidth: 0 }}>
    <div style={{ fontSize: 13, fontWeight: 700, overflowWrap: 'anywhere' }}>{task.company} · {task.role}</div>
    <p style={{ margin: '8px 0 4px', fontSize: 13, fontWeight: 650 }}>{t(state.labelKey)}</p>
    <p style={{ margin: '0 0 10px', color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5 }}>{t(state.descriptionKey)}</p>
    {evidence ? <div aria-label={evidence.heading} style={{ margin: '0 0 10px', fontSize: 12, lineHeight: 1.5 }}>
      <strong>{evidence.heading}</strong>
      <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '2px 8px', margin: '4px 0 0' }}>
        <dt>{evidence.workerReportLabel}</dt><dd style={{ margin: 0 }}>{evidence.workerReportValue}</dd>
        <dt>{evidence.localRecordLabel}</dt><dd style={{ margin: 0 }}>{evidence.localRecordValue}</dd>
        <dt>{evidence.employerReceiptLabel}</dt><dd style={{ margin: 0 }}>{evidence.employerReceiptValue}</dd>
      </dl>
      {evidence.unavailableNotice ? <p role="note" style={{ margin: '4px 0 0', color: 'var(--text-muted)' }}>{evidence.unavailableNotice}</p> : null}
    </div> : null}
    {href ? <a href={href} onClick={event => {
      if (!onOpenSession || !task.sessionId || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      onOpenSession(task.sessionId)
    }} style={{ display: 'inline-flex', alignItems: 'center', minHeight: 36, color: 'var(--accent, #4f46e5)', fontSize: 13, fontWeight: 650 }}>{t(state.actionKey)}</a>
      : <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>{t('jobs.task.sessionUnavailable')}</p>}
  </section>
}
