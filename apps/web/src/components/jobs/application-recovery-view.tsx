'use client'

import React, { useRef, useState } from 'react'
import type { RecoveryDraft } from '@/lib/application-recovery-draft'
import { useI18n } from '@/lib/i18n'

export function ApplicationRecoveryView({ draft, onContinue, onRefreshSession }: {
  draft: RecoveryDraft | null
  onContinue?: () => void
  onRefreshSession?: () => void
}) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const text = draft ? JSON.stringify({ name: draft.name, content: draft.content, sectionOrder: draft.sectionOrder, templateId: draft.templateId, templateOptions: draft.templateOptions }, null, 2) : ''
  const selectForCopy = () => { textareaRef.current?.focus(); textareaRef.current?.select() }
  return <main style={{ maxWidth: 760, margin: '48px auto', padding: 24 }}>
    <h1>{t('resume.recoveryTitle')}</h1>
    {draft ? <>
      <p>{t('resume.recoveryInstructions')}</p>
      <label htmlFor="recovery-draft">{t('resume.recoveryDraft')}</label>
      <textarea ref={textareaRef} id="recovery-draft" readOnly value={text} rows={18} style={{ width: '100%', margin: '12px 0' }} />
      <button type="button" onClick={() => {
        if (!navigator.clipboard?.writeText) { selectForCopy(); return }
        void navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(selectForCopy)
      }}>{t('resume.recoveryCopy')}</button>
      {copied && <span role="status"> {t('resume.recoveryCopied')}</span>}
      <button type="button" onClick={() => { if (window.confirm(t('resume.recoveryConfirm'))) onContinue?.() }} style={{ marginLeft: 12 }}>{t('resume.recoveryContinue')}</button>
    </> : <>
      <p>{t('resume.recoverySignIn')}</p>
      <a href="/login?callbackUrl=%2F" target="_blank" rel="noopener noreferrer">{t('resume.recoveryOpenLogin')}</a>
      <button type="button" onClick={onRefreshSession} style={{ marginLeft: 12 }}>{t('resume.recoveryRefresh')}</button>
    </>}
  </main>
}
