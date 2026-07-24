'use client'

import { useState } from 'react'
import { AlertTriangle, Check, LoaderCircle, ShieldCheck, X } from 'lucide-react'
import type { ResumeAuditResult } from '@/lib/resume-audit'

type Props = {
  resumeName: string
  onClose: () => void
  onSaveAndAudit: () => Promise<ResumeAuditResult | null>
}

export function ResumeAuditDialog({ resumeName, onClose, onSaveAndAudit }: Props) {
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
      <button className="final-confirm-close" onClick={onClose} aria-label="Close resume audit"><X size={18} /></button>
      <div className="final-confirm-heading">
        <span className="final-confirm-shield"><ShieldCheck size={17} /></span>
        <div><h2 id="resume-audit-title">Resume audit</h2><p>{result ? 'Review each finding before you use this version to apply.' : 'When a job and matching cover letter are linked, this runs the same evidence-based audit used for the final application pack.'}</p></div>
      </div>

      {!result ? <>
        <label style={{ display: 'flex', gap: 9, padding: 12, border: '0.5px solid var(--border)', borderRadius: 8, fontSize: 12, lineHeight: 1.5, cursor: 'pointer' }}>
          <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} style={{ marginTop: 3 }} />
          <span>I confirm that I have reviewed and optimized this resume. All facts, dates, qualifications, and achievements are truthful and can be supported if asked.</span>
        </label>
        <p className="final-confirm-note">Without a linked job, original source version, and matching cover letter, only local quality checks are available; factual verification happens in the independent audit.</p>
        <div className="final-confirm-footer"><button className="final-confirm-secondary" onClick={onClose}>Back to edit</button><button className="final-confirm-primary" disabled={!confirmed || running} onClick={() => void startAudit()}>{running ? <LoaderCircle size={16} /> : <ShieldCheck size={16} />}{running ? 'Saving & auditing…' : 'Confirm, save & audit'}</button></div>
      </> : <>
        <div className="resume-audit-findings" aria-live="polite">
          {result.findings.map(finding => <div className={`resume-audit-finding is-${finding.severity}`} key={finding.id}>
            <span className="resume-audit-finding-icon">{finding.severity === 'pass' ? <Check size={16} /> : <AlertTriangle size={16} />}</span>
            <div className="resume-audit-finding-copy"><strong>{finding.title}</strong><span>{finding.detail}</span></div>
            <span className="resume-audit-finding-status">{finding.severity === 'pass' ? 'Passed' : finding.severity === 'needs-confirmation' ? 'Confirm' : 'Review'}</span>
          </div>)}
        </div>
        <div className="final-confirm-footer"><span className="final-confirm-resume-name">{resumeName}</span><button className="final-confirm-primary" onClick={onClose}><Check size={16} />Done</button></div>
      </>}
    </section>
  </div>
}
