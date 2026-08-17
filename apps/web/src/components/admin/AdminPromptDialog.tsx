'use client'

import { useRef, useState } from 'react'
import { useI18n } from '@/lib/i18n'

type PromptKind = 'reason' | 'text' | 'datetime'
type PromptConfig = { title: string; label: string; kind?: PromptKind; initialValue?: string; submitLabel?: string; description?: string }

export function useAdminPrompt() {
  const { t } = useI18n()
  const [config, setConfig] = useState<PromptConfig | null>(null)
  const [value, setValue] = useState('')
  const resolver = useRef<((value: string | null) => void) | null>(null)
  function request(next: PromptConfig) {
    return new Promise<string | null>((resolve) => { resolver.current = resolve; setValue(next.initialValue ?? ''); setConfig(next) })
  }
  function close(result: string | null) {
    resolver.current?.(result)
    resolver.current = null
    setConfig(null)
  }
  const reasonTooShort = config?.kind === 'reason' && value.trim().length > 0 && value.trim().length < 10
  const dialog = config ? <div className="security-dialog-backdrop"><form className="security-card security-dialog" role="dialog" aria-modal="true" onSubmit={(event) => { event.preventDefault(); close(value.trim()) }}><h2>{config.title}</h2>{config.description && <p>{config.description}</p>}<label>{config.label}{config.kind === 'datetime' ? <input type="datetime-local" required value={value} onChange={(event) => setValue(event.target.value)} autoFocus /> : <textarea required minLength={config.kind === 'reason' || !config.kind ? 10 : undefined} maxLength={config.kind === 'reason' ? 500 : 5000} rows={config.kind === 'text' ? 3 : 4} value={value} onChange={(event) => setValue(event.target.value)} autoFocus />}</label>{reasonTooShort && <small role="alert" style={{ display: 'block', marginTop: 6, color: '#a32d2d' }}>{t('adminPrompt.reasonTooShort')}</small>}<div className="admin-inline-actions"><button className="admin-row-action" type="button" onClick={() => close(null)}>{t('common.cancel')}</button><button className="broadcast-primary" type="submit" disabled={!value.trim() || Boolean(reasonTooShort)} style={{ opacity: !value.trim() || reasonTooShort ? 0.55 : 1, cursor: !value.trim() || reasonTooShort ? 'not-allowed' : 'pointer' }}>{config.submitLabel ?? t('adminPrompt.continue')}</button></div></form></div> : null
  return { request, dialog }
}
