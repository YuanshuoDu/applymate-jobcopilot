'use client'

import { useState } from 'react'
import { AlertTriangle, Check, LoaderCircle, ShieldCheck, X } from 'lucide-react'
import type { ResumeAuditResult } from '@/lib/resume-audit'
import { useI18n } from '@/lib/i18n'

type Props = {
  resumeName: string
  onClose: () => void
  onSaveAndAudit: () => Promise<ResumeAuditResult | null>
}

export function ResumeAuditDialog({ resumeName, onClose, onSaveAndAudit }: Props) {
  const { t } = useI18n()
  const [confirmed, setConfirmed] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ResumeAuditResult | null>(null)

  async function startAudit() {
    setRunning(true)
    const next = await onSaveAndAudit()
    setRunning(false)
    if (next) setResult(next)
  }

  return <div className="final-confirm-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="final-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="resume-audit-title">
      <button className="final-confirm-close" onClick={onClose} aria-label={t('resume.closeAudit')}><X size={18} /></button>
      <div className="final-confirm-heading">
        <span className="final-confirm-shield"><ShieldCheck size={17} /></span>
        <div><h2 id="resume-audit-title">{t('resume.resumeAudit')}</h2><p>{result ? t('resume.reviewFindings') : t('resume.auditLinkedMaterials')}</p></div>
      </div>

      {!result ? <>
        <label style={{ display: 'flex', gap: 9, padding: 12, border: '0.5px solid var(--border)', borderRadius: 8, fontSize: 12, lineHeight: 1.5, cursor: 'pointer' }}>
          <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} style={{ marginTop: 3 }} />
          <span>{t('resume.confirmTruthful')}</span>
        </label>
        <p className="final-confirm-note">{t('resume.localChecksOnly')}</p>
        <div className="final-confirm-footer"><button className="final-confirm-secondary" onClick={onClose}>{t('resume.backToEdit')}</button><button className="final-confirm-primary" disabled={!confirmed || running} onClick={() => void startAudit()}>{running ? <LoaderCircle size={16} /> : <ShieldCheck size={16} />}{running ? t('resume.savingAuditing') : t('resume.confirmSaveAudit')}</button></div>
      </> : <>
        <div className="resume-audit-findings" aria-live="polite">
          {result.findings.map(finding => <div className={`resume-audit-finding is-${finding.severity}`} key={finding.id}>
            <span className="resume-audit-finding-icon">{finding.severity === 'pass' ? <Check size={16} /> : <AlertTriangle size={16} />}</span>
            <div className="resume-audit-finding-copy"><strong>{finding.title}</strong><span>{finding.detail}</span></div>
            <span className="resume-audit-finding-status">{finding.severity === 'pass' ? t('resume.passed') : finding.severity === 'needs-confirmation' ? t('resume.confirm') : t('common.review')}</span>
          </div>)}
        </div>
        <div className="final-confirm-footer"><span className="final-confirm-resume-name">{resumeName}</span><button className="final-confirm-primary" onClick={onClose}><Check size={16} />{t('common.done')}</button></div>
      </>}
    </section>
  </div>
}
