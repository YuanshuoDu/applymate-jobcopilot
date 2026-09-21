'use client'

import { AlertTriangle, Check, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react'
import type { ApplicationAudit } from '@/lib/types'
import { useI18n } from '@/lib/i18n'

type Props = {
  audit: ApplicationAudit | null | undefined
  auditing: boolean
  auditError?: string | null
  hasLinkedJob: boolean
  hasCoverLetter: boolean
  onAudit: () => void
}

function statusCopy(audit: ApplicationAudit | null | undefined, auditing: boolean, t: (key: string) => string) {
  if (auditing) return { label: t('resume.auditRunning'), tone: 'running' }
  if (!audit) return { label: t('resume.auditNotRun'), tone: 'idle' }
  if (audit.verdict === 'pass') return { label: t('resume.auditPassed'), tone: 'pass' }
  if (audit.verdict === 'blocked') return { label: t('resume.auditBlockedShort'), tone: 'blocked' }
  return { label: t('resume.auditNeedsReviewShort'), tone: 'needs-review' }
}

export function ResumeAuditCard({ audit, auditing, auditError, hasLinkedJob, hasCoverLetter, onAudit }: Props) {
  const { t } = useI18n()
  const status = statusCopy(audit, auditing, t)
  const unresolvedFindings = audit?.findings.filter(finding => finding.severity !== 'pass') ?? []

  return (
    <section className={`resume-audit-card is-${status.tone}`} data-resume-audit-card aria-live="polite">
      <div className="resume-audit-card-heading">
        <span className="resume-audit-card-icon">
          {auditing ? <LoaderCircle size={15} /> : audit?.verdict === 'pass' ? <Check size={15} /> : <ShieldCheck size={15} />}
        </span>
        <div className="resume-audit-card-title">
          <strong>{t('resume.independentAudit')}</strong>
          <span>{hasCoverLetter ? t('resume.auditScopeResumeAndCoverLetter') : t('resume.auditScopeResumeOnly')}</span>
        </div>
        <span className="resume-audit-card-status">{status.label}</span>
      </div>

      {!hasLinkedJob ? (
        <p className="resume-audit-card-message">{t('resume.auditLinkJobHint')}</p>
      ) : auditing ? (
        <p className="resume-audit-card-message">{t('resume.auditRunningDetail')}</p>
      ) : audit ? (
        <>
          <p className="resume-audit-card-message">{audit.summary}</p>
          {audit.verdict === 'pass' ? (
            <p className="resume-audit-card-success"><Check size={13} /> {t('resume.auditNoIssues')}</p>
          ) : (
            <div className="resume-audit-card-findings">
              {unresolvedFindings.map((finding, index) => (
                <div className="resume-audit-card-finding" key={`${finding.title}-${index}`}>
                  <AlertTriangle size={13} />
                  <div>
                    <strong>{finding.title}</strong>
                    <span>{finding.evidence}</span>
                    <em>{finding.action}</em>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="resume-audit-card-message">{t('resume.auditReadyDetail')}</p>
      )}

      {auditError && <p className="resume-audit-card-error" role="alert">{auditError}</p>}

      <button className="resume-audit-card-action" type="button" disabled={!hasLinkedJob || auditing} onClick={onAudit}>
        {auditing ? <LoaderCircle size={14} /> : audit ? <RefreshCw size={14} /> : <ShieldCheck size={14} />}
        {auditing ? t('resume.auditRunning') : audit ? t('resume.auditRunAgain') : t('resume.auditRun')}
      </button>
    </section>
  )
}
