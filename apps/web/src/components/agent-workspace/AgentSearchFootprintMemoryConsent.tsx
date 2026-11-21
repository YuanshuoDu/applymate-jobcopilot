'use client'

import React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n'

type Consent = { enabled: boolean; version: number }
type ConsentMessage = 'loadFailed' | 'saveFailed' | 'conflict' | 'versionExhausted'
type Copy = {
  title: string; description: string; scope: string; permission: string; revocation: string; toggleLabel: string
  loading: string; loadFailed: string; saveFailed: string; conflict: string; versionExhausted: string; retry: string
  enabledAtLimit: string; disabledAtLimit: string; on: string; off: string; onUnavailable: string
}
const ENDPOINT = '/api/me/agent-search-footprint-memory'
const MAX_CONSENT_VERSION = 2_147_483_647
const EN: Copy = {
  title: 'Search criteria memory',
  description: 'With consent enabled, future Sessions may refer to bounded role, location, and ATS source criteria from earlier Sessions, when available.',
  scope: 'Historical criteria are advisory, not evidence about current search results. Each objective still requires a fresh search; this switch shows the saved choice.',
  permission: 'This choice is separate from Task History. It grants no tools, approvals, or authority to act, apply, submit, or contact employers.',
  revocation: 'Turning this off blocks later reads. Re-enabling does not restore access for Sessions created under an earlier consent version. Context already sent to an AI provider cannot be recalled.',
  toggleLabel: 'Allow future Sessions to refer to bounded search criteria', loading: 'Loading…',
  loadFailed: 'Could not load this setting. Try again.', saveFailed: "We couldn't confirm this change. Please try again.",
  conflict: 'This setting changed elsewhere. The latest saved choice is shown.',
  versionExhausted: 'This choice reached its version limit. If it is on, you may still turn it off; it cannot be turned on again afterward.',
  retry: 'Retry', enabledAtLimit: 'Search history is unavailable at this version limit. You can turn off the saved choice, but it cannot be turned on again afterward.',
  disabledAtLimit: 'Search history is unavailable and this choice is off. It cannot be turned on again.',
  on: 'On', off: 'Off', onUnavailable: 'On (unavailable)',
}
const ZH: Copy = {
  title: '搜索条件记忆',
  description: '你同意后，未来会话在有可用数据时，可参考早前会话中有限的职位、地点及 ATS 来源条件。',
  scope: '这些历史条件仅供参考，不是当前搜索结果的证据。每个目标仍需重新搜索；此开关显示已保存的选择。',
  permission: '此设置独立于任务历史。它不会授予工具、审批或执行操作、申请、提交或联系雇主的权限。',
  revocation: '关闭后会阻止后续读取。重新开启不会恢复在较早许可版本下创建的会话的读取权限。已发送给 AI 服务商的上下文无法撤回。',
  toggleLabel: '允许未来会话参考有限的搜索条件', loading: '正在加载…',
  loadFailed: '无法加载此设置，请重试。', saveFailed: '无法确认这次更改，请重试。',
  conflict: '此设置已在其他位置更改，现显示最新保存的选择。',
  versionExhausted: '此选择已达到版本上限。若当前已开启，仍可关闭；关闭后无法再次开启。',
  retry: '重试', enabledAtLimit: '已达到版本上限，搜索历史不可用。你仍可关闭此选择，但关闭后无法再次开启。',
  disabledAtLimit: '已达到版本上限，搜索历史不可用且当前为关闭状态，无法再次开启。',
  on: '已开启', off: '已关闭', onUnavailable: '已开启（不可用）',
}

function parseConsent(value: unknown): Consent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  return typeof row.enabled === 'boolean' && Number.isSafeInteger(row.version)
    && Number(row.version) >= 0 && Number(row.version) <= MAX_CONSENT_VERSION
    ? { enabled: row.enabled, version: Number(row.version) } : null
}

type ConsentSaveResult =
  | { kind: 'saved'; consent: Consent }
  | { kind: 'conflict'; consent: Consent }
  | { kind: 'exhausted'; consent: Consent }
  | { kind: 'invalid' }

function parseConsentSaveResponse(status: number, value: unknown): ConsentSaveResult {
  const consent = parseConsent(value)
  if (!consent) return { kind: 'invalid' }
  if (status === 409 && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const error = (value as Record<string, unknown>).error
    if (error === 'VERSION_EXHAUSTED' && consent.version === MAX_CONSENT_VERSION) return { kind: 'exhausted', consent }
    if (error === 'VERSION_CONFLICT') return consent.version === MAX_CONSENT_VERSION
      ? { kind: 'exhausted', consent }
      : { kind: 'conflict', consent }
  }
  return status === 200 ? { kind: 'saved', consent } : { kind: 'invalid' }
}

export function AgentSearchFootprintMemoryConsent() {
  const { lang } = useI18n()
  const copy = lang === 'zh' ? ZH : EN
  const [consent, setConsent] = useState<Consent | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<ConsentMessage | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch(ENDPOINT, { cache: 'no-store' })
      const current = parseConsent(await response.json())
      if (!response.ok || !current) throw new Error('invalid consent response')
      setConsent(current)
      setMessage(null)
    } catch {
      setMessage('loadFailed')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void reload() }, [reload])

  async function update(enabled: boolean) {
    if (!consent || saving) return
    setSaving(true)
    setMessage(null)
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, expectedVersion: consent.version }),
      })
      const result = parseConsentSaveResponse(response.status, await response.json().catch(() => null))
      if (result.kind === 'invalid') throw new Error('invalid consent response')
      setConsent(result.consent)
      setMessage(result.kind === 'conflict' ? 'conflict' : result.kind === 'exhausted' ? 'versionExhausted' : null)
    } catch {
      setMessage('saveFailed')
    } finally { setSaving(false) }
  }

  const unavailable = consent?.version === MAX_CONSENT_VERSION
  const lockedOff = unavailable && consent?.enabled === false

  return (
    <section aria-labelledby="search-footprint-memory-title" style={{ margin: '0 10px 12px', padding: 10, border: '1px solid var(--border)', borderRadius: 8 }}>
      <div id="search-footprint-memory-title" style={{ fontSize: 11, fontWeight: 700 }}>{copy.title}</div>
      <p style={{ margin: '5px 0 8px', color: 'var(--text-muted)', fontSize: 10, lineHeight: 1.5 }}>
        {copy.description}
      </p>
      <p style={{ margin: '5px 0 8px', color: 'var(--text-muted)', fontSize: 10, lineHeight: 1.5 }}>{copy.scope}</p>
      <p style={{ margin: '5px 0 8px', color: 'var(--text-muted)', fontSize: 10, lineHeight: 1.5 }}>{copy.permission}</p>
      <p style={{ margin: '5px 0 8px', color: 'var(--text-muted)', fontSize: 10, lineHeight: 1.5 }}>{copy.revocation}</p>
      {unavailable && <div role="status" style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 10 }}>
        {consent?.enabled ? copy.enabledAtLimit : copy.disabledAtLimit}
      </div>}
      <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, cursor: loading || saving || !consent || lockedOff ? 'wait' : 'pointer' }}>
        <input
          type="checkbox"
          aria-label={copy.toggleLabel}
          checked={consent?.enabled ?? false}
          disabled={loading || saving || !consent || lockedOff}
          onChange={event => { void update(event.currentTarget.checked) }}
        />
        {loading ? copy.loading : unavailable && consent?.enabled ? copy.onUnavailable : consent?.enabled ? copy.on : copy.off}
      </label>
      {message && <div role="status" style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 10 }}>{copy[message]}</div>}
      {!loading && !consent && <button type="button" onClick={() => { void reload() }} style={{ marginTop: 6 }}>{copy.retry}</button>}
    </section>
  )
}
