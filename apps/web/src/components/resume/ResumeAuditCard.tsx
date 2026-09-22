'use client'

import { useState } from 'react'
import { Check, Clipboard, ExternalLink, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react'
import type { ApplicationAudit, ApplicationAuditFinding } from '@/lib/types'
import { useI18n } from '@/lib/i18n'

type AuditTone = 'running' | 'idle' | 'pass' | 'blocked' | 'needs-review'

type Props = {
  audit: ApplicationAudit | null | undefined
  auditing: boolean
  auditError?: string | null
  auditStale?: boolean
  applyingIndex?: number | null
  hasLinkedJob: boolean
  hasCoverLetter: boolean
  onReviewFinding?: (area: ApplicationAuditFinding['area']) => void
  onApplyFinding?: (index: number) => void
  onAudit: () => void
}

function statusCopy(audit: ApplicationAudit | null | undefined, auditing: boolean, auditStale: boolean, t: (key: string) => string) {
  if (auditing) return { label: t('resume.auditRunning'), tone: 'running' as AuditTone }
  if (!audit) return { label: t('resume.auditNotRun'), tone: 'idle' as AuditTone }
  if (auditStale) return { label: t('resume.auditNeedsRerunShort'), tone: 'needs-review' as AuditTone }
  if (audit.verdict === 'pass') return { label: t('resume.auditPassed'), tone: 'pass' as AuditTone }
  if (audit.verdict === 'blocked') return { label: t('resume.auditBlockedShort'), tone: 'blocked' as AuditTone }
  return { label: t('resume.auditNeedsReviewShort'), tone: 'needs-review' as AuditTone }
}

function areaLabel(area: ApplicationAuditFinding['area'], t: (key: string) => string) {
  if (area === 'cover_letter') return t('resume.auditAreaCoverLetter')
  if (area === 'job_match') return t('resume.auditAreaJobMatch')
  return t('resume.auditAreaResume')
}

function proposedText(value: unknown) {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return '' }
}

export function ResumeAuditCard({ audit, auditing, auditError, auditStale = false, applyingIndex = null, hasLinkedJob, hasCoverLetter, onReviewFinding, onApplyFinding, onAudit }: Props) {
  const { t } = useI18n()
  const [copiedFinding, setCopiedFinding] = useState<number | null>(null)
  const status = statusCopy(audit, auditing, auditStale, t)
  const unresolvedFindings = audit?.findings
    .map((finding, index) => ({ finding, index }))
    .filter(({ finding }) => finding.severity !== 'pass') ?? []
  const appliedFindings = unresolvedFindings.filter(({ finding }) => finding.applied).length

  async function copyValue(value: string, index: number) {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedFinding(index)
      window.setTimeout(() => setCopiedFinding(current => current === index ? null : current), 1500)
    } catch {
      // Clipboard access is optional; the action remains visible in the card.
    }
  }

  return (
    <section className={`resume-audit-card is-${status.tone}`} data-resume-audit-card aria-live="polite">
      <div className="resume-audit-card-heading">
        <span className="resume-audit-card-icon">
          {auditing ? <LoaderCircle size={15} /> : audit?.verdict === 'pass' && !auditStale ? <Check size={15} /> : <ShieldCheck size={15} />}
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
          {auditStale && <p className="resume-audit-card-stale">{t('resume.auditChangedSinceRun')}</p>}
          {audit.verdict === 'pass' && !auditStale ? (
            <p className="resume-audit-card-success"><Check size={13} /> {t('resume.auditNoIssues')}</p>
          ) : (
            <div className="resume-audit-card-findings">
              <div className="resume-audit-card-findings-heading">
                <strong>{t('resume.auditFindingsTitle')}</strong>
                <span>{unresolvedFindings.filter(({ finding }) => !finding.applied).length} {t('resume.auditFindingsCount')}{appliedFindings > 0 ? ` · ${appliedFindings} ${t('resume.auditAppliedCount')}` : ''}</span>
              </div>
              {unresolvedFindings.map(({ finding, index }) => (
                <article className={`resume-audit-card-finding${finding.applied ? ' is-applied' : ''}`} key={`${finding.title}-${index}`}>
                  <div className="resume-audit-card-finding-heading">
                    <span className={`resume-audit-card-severity is-${finding.severity}`}>
                      {finding.severity === 'critical' ? t('resume.auditCritical') : t('resume.auditWarning')}
                    </span>
                    <span className="resume-audit-card-area">{areaLabel(finding.area, t)}</span>
                  </div>
                  <strong>{finding.title}</strong>
                  <p><b>{t('resume.auditEvidenceLabel')}:</b> {finding.evidence}</p>
                  <p className="resume-audit-card-action-copy"><b>{t('resume.auditActionLabel')}:</b> {finding.action}</p>
                  {finding.proposedValue !== undefined && (
                    <div className="resume-audit-card-proposed">
                      <b>{t('resume.auditGeneratedLabel')}:</b>
                      <pre>{proposedText(finding.proposedValue)}</pre>
                    </div>
                  )}
                  <div className="resume-audit-card-finding-actions">
                    {onReviewFinding && (
                      <button type="button" onClick={() => onReviewFinding(finding.area)}>
                        <ExternalLink size={12} />
                        {finding.area === 'cover_letter' ? t('resume.auditEditCoverLetter') : finding.area === 'job_match' ? t('resume.auditReviewJob') : t('resume.auditEditResume')}
                      </button>
                    )}
                    {onApplyFinding && finding.area !== 'job_match' && (
                      <button type="button" disabled={finding.applied || auditStale || applyingIndex === index} onClick={() => onApplyFinding(index)}>
                        {applyingIndex === index ? <LoaderCircle size={12} /> : finding.applied ? <Check size={12} /> : null}
                        {finding.applied ? t('resume.auditAppliedAction') : finding.proposedValue !== undefined ? t('resume.auditApplyGenerated') : t('resume.auditGenerateAndApply')}
                      </button>
                    )}
                    {finding.proposedValue !== undefined && (
                      <button type="button" onClick={() => void copyValue(proposedText(finding.proposedValue), index)}>
                        <Clipboard size={12} />
                        {copiedFinding === index ? t('resume.auditCopiedAction') : t('resume.auditCopyGenerated')}
                      </button>
                    )}
                    <button type="button" onClick={() => void copyValue(finding.action, index)}>
                      <Clipboard size={12} />
                      {copiedFinding === index ? t('resume.auditCopiedAction') : t('resume.auditCopyAction')}
                    </button>
                  </div>
                </article>
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
      {audit && audit.verdict !== 'pass' && !auditing && (
        <p className="resume-audit-card-hint">{t('resume.auditFixThenRerun')}</p>
      )}
    </section>
  )
}
