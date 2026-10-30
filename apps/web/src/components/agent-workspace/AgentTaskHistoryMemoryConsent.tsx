'use client'

import React, { useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n'

const ENDPOINT = '/api/me/agent-task-history-memory'
const MAX_CONSENT_VERSION = 2_147_483_647

type ConsentSnapshot = { enabled: boolean; version: number }

type Copy = {
  title: string
  description: string
  permission: string
  revocation: string
  loading: string
  loadFailed: string
  saveFailed: string
  conflict: string
  versionExhausted: string
  saved: string
}

const EN: Copy = {
  title: 'Use prior terminal Root TaskGraph outcomes',
  description: 'When enabled and available, planning may consider a small, bounded summary of historical terminal outcomes from completed Root TaskGraphs for the same verified objective, origin, and intent. This does not cover all Agent tasks or activity. The summary is advisory only.',
  permission: 'This is permission only. Use also depends on the server rollout, so enabling this setting does not mean the service is currently available. It grants no tool, approval, credential, application, send, submit, or other action authority, and does not start an Agent task.',
  revocation: 'This setting is off by default. Turning it off stops new Sessions from receiving memory permission. A Session that already pinned a choice keeps it; information already sent to an AI provider cannot be recalled.',
  loading: 'Loading your saved choice…',
  loadFailed: 'Could not load your saved choice. The control stays disabled and your saved setting is unchanged. Refresh and try again.',
  saveFailed: 'Could not save this choice. Your saved setting was not changed.',
  conflict: 'This choice changed in another tab. The latest saved choice is shown; review it before changing it again.',
  versionExhausted: 'This setting can no longer be changed. The latest saved choice is shown.',
  saved: 'Your choice has been saved.',
}

const ZH: Copy = {
  title: '使用先前已结束的根 TaskGraph 结果',
  description: '启用且服务可用时，规划可参考同一已验证目标、来源和意图下先前已完成 Root TaskGraph 的历史终态结果摘要，且摘要范围有限。它不涵盖所有 Agent 任务或活动，仅供参考。',
  permission: '此设置只记录你的许可。是否实际使用还取决于服务端的发布状态，因此启用不代表服务当前可用。它不会授予工具、审批、凭据、申请、发送、提交或其他操作权限，也不会启动 Agent 任务。',
  revocation: '此设置默认关闭。关闭后新会话不会获得使用记忆的许可；已固定选择的会话会保留该选择，已发送给 AI 服务商的信息无法撤回。',
  loading: '正在读取已保存的选择…',
  loadFailed: '无法读取已保存的选择。控件已禁用，已保存的设置不会更改。请刷新后重试。',
  saveFailed: '无法保存此选择，已保存的设置未更改。',
  conflict: '此选择已在另一个标签页中更改。现已显示最新保存的选择；如需更改，请先确认后再操作。',
  versionExhausted: '此设置已无法继续更改。现已显示最新保存的选择。',
  saved: '选择已保存。',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseAgentTaskHistoryMemoryConsent(value: unknown): ConsentSnapshot | null {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') return null
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 0) return null
  return { enabled: value.enabled, version: value.version as number }
}

type SaveResponse =
  | { kind: 'saved'; consent: ConsentSnapshot }
  | { kind: 'conflict'; consent: ConsentSnapshot }
  | { kind: 'version-exhausted'; consent: ConsentSnapshot }
  | { kind: 'invalid' }

export function parseAgentTaskHistoryMemorySaveResponse(status: number, value: unknown): SaveResponse {
  const consent = parseAgentTaskHistoryMemoryConsent(value)
  if (status === 409 && consent && isRecord(value)) {
    if (value.error === 'VERSION_CONFLICT') return { kind: 'conflict', consent }
    if (value.error === 'VERSION_EXHAUSTED') return { kind: 'version-exhausted', consent }
  }
  return status === 200 && consent ? { kind: 'saved', consent } : { kind: 'invalid' }
}

export function agentTaskHistoryMemoryConsentRequestBody(enabled: boolean, expectedVersion: number) {
  return { enabled, expectedVersion }
}

function canChangeConsent(consent: ConsentSnapshot | null): consent is ConsentSnapshot {
  return consent !== null && consent.version < MAX_CONSENT_VERSION
}

export function AgentTaskHistoryMemoryConsent() {
  const { lang } = useI18n()
  const copy = lang === 'zh' ? ZH : EN
  const [consent, setConsent] = useState<ConsentSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const response = await fetch(ENDPOINT, { cache: 'no-store' })
        const payload: unknown = await response.json().catch(() => null)
        if (!response.ok) throw new Error('load failed')
        const savedChoice = parseAgentTaskHistoryMemoryConsent(payload)
        if (!savedChoice) throw new Error('invalid response')
        if (!cancelled) setConsent(savedChoice)
      } catch {
        if (!cancelled) setError(copy.loadFailed)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [copy])

  async function saveChoice(enabled: boolean) {
    if (!canChangeConsent(consent) || saving) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(agentTaskHistoryMemoryConsentRequestBody(enabled, consent.version)),
      })
      const payload: unknown = await response.json().catch(() => null)
      const result = parseAgentTaskHistoryMemorySaveResponse(response.status, payload)
      if (result.kind === 'invalid') throw new Error('save failed')
      setConsent(result.consent)
      if (result.kind === 'conflict') {
        setNotice(copy.conflict)
        return
      }
      if (result.kind === 'version-exhausted') {
        setError(copy.versionExhausted)
        return
      }
      if (!response.ok) throw new Error('save failed')
      setNotice(copy.saved)
    } catch {
      setError(copy.saveFailed)
    } finally {
      setSaving(false)
    }
  }

  const canChange = canChangeConsent(consent) && !loading && !saving

  return (
    <section aria-label={copy.title} style={{ margin: '0 10px 10px', padding: 10, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 650, color: 'var(--text)', lineHeight: 1.4 }}>{copy.title}</div>
        <button
          type="button"
          role="switch"
          aria-label={copy.title}
          aria-checked={consent?.enabled ?? false}
          disabled={!canChange}
          onClick={() => { if (consent) void saveChoice(!consent.enabled) }}
          style={{ width: 32, height: 18, flexShrink: 0, border: 0, padding: 0, borderRadius: 9, background: consent?.enabled ? 'var(--primary)' : 'var(--border)', cursor: canChange ? 'pointer' : 'not-allowed', position: 'relative', opacity: canChange ? 1 : 0.55 }}
        >
          <span aria-hidden="true" style={{ width: 14, height: 14, borderRadius: '50%', background: '#fff', position: 'absolute', top: 2, left: consent?.enabled ? 16 : 2 }} />
        </button>
      </div>
      <p style={{ margin: '7px 0 0', fontSize: 10, lineHeight: 1.45, color: 'var(--text-muted)' }}>{copy.description}</p>
      <p style={{ margin: '6px 0 0', fontSize: 10, lineHeight: 1.45, color: 'var(--text-muted)' }}>{copy.permission}</p>
      <p style={{ margin: '6px 0 0', fontSize: 10, lineHeight: 1.45, color: 'var(--text-muted)' }}>{copy.revocation}</p>
      {(loading || error || notice) && (
        <div aria-live="polite" role={error ? 'alert' : 'status'} style={{ marginTop: 6, fontSize: 10, lineHeight: 1.4, color: error ? 'var(--c-danger)' : 'var(--text-muted)' }}>
          {loading ? copy.loading : error ?? notice}
        </div>
      )}
    </section>
  )
}
