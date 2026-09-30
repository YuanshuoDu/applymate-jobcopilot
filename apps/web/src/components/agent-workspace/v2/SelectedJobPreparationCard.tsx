'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'

import { useI18n } from '@/lib/i18n'

import { createSelectedJobPreparationMessageId, postSelectedJobPreparation } from './selected-job-preparation-action'

interface SavedJob { readonly id: string; readonly company: string; readonly role: string }
interface JobsResponse { readonly jobs?: unknown }
interface ScopedValue<T> { readonly scope: string; readonly value: T }

export function SelectedJobPreparationCard({ sessionId, onAccepted }: { readonly sessionId: string; readonly onAccepted: (turnId: string, sequence: string) => void }) {
  const { data: authSession, status: authStatus } = useSession()
  const { lang } = useI18n()
  const userId = authStatus === 'authenticated' ? authSession?.user?.id ?? null : null
  const scope = `${userId ?? 'anonymous'}:${sessionId}`
  const [jobsState, setJobsState] = useState<ScopedValue<{ jobs: SavedJob[]; error: boolean; loading: boolean }> | null>(null)
  const [selection, setSelection] = useState<ScopedValue<string> | null>(null)
  const [pending, setPending] = useState<ScopedValue<boolean> | null>(null)
  const [feedback, setFeedback] = useState<ScopedValue<'accepted' | 'failed' | 'conflict'> | null>(null)
  const idsRef = useRef(new Map<string, string>())
  const epochRef = useRef(0)
  const previousScopeRef = useRef(scope)
  if (previousScopeRef.current !== scope) {
    previousScopeRef.current = scope
    epochRef.current += 1
  }

  useEffect(() => {
    if (!userId || !sessionId) {
      setJobsState({ scope, value: { jobs: [], error: false, loading: false } })
      return
    }
    const controller = new AbortController()
    setJobsState({ scope, value: { jobs: [], error: false, loading: true } })
    void fetch('/api/jobs?status=saved&page=1&pageSize=100', { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        const body = await response.json().catch(() => null) as JobsResponse | null
        if (!response.ok) throw new Error('saved jobs unavailable')
        return parseSavedJobs(body?.jobs)
      })
      .then(jobs => { if (!controller.signal.aborted) setJobsState({ scope, value: { jobs, error: false, loading: false } }) })
      .catch(() => { if (!controller.signal.aborted) setJobsState({ scope, value: { jobs: [], error: true, loading: false } }) })
    return () => controller.abort()
  }, [scope, sessionId, userId])

  const jobs = jobsState?.scope === scope ? jobsState.value.jobs : []
  const loadingJobs = jobsState?.scope !== scope || jobsState.value.loading
  const jobsError = jobsState?.scope === scope && jobsState.value.error
  const selectedJobId = selection?.scope === scope ? selection.value : ''
  const isPending = pending?.scope === scope && pending.value
  const currentFeedback = feedback?.scope === scope ? feedback.value : null
  const copy = localized(lang)

  const startPreparation = useCallback(() => {
    if (!selectedJobId || isPending) return
    const epoch = epochRef.current
    const target = `${scope}:${selectedJobId}`
    const clientMessageId = idsRef.current.get(target) ?? createSelectedJobPreparationMessageId()
    idsRef.current.set(target, clientMessageId)
    setPending({ scope, value: true })
    setFeedback(null)
    void postSelectedJobPreparation({ sessionId, jobId: selectedJobId, clientMessageId }).then(response => {
      if (epoch !== epochRef.current) return
      idsRef.current.delete(target)
      setFeedback({ scope, value: 'accepted' })
      onAccepted(response.turnId, response.sequence)
    }).catch(error => {
      if (epoch !== epochRef.current) return
      setFeedback({ scope, value: error instanceof Error && 'status' in error && error.status === 409 ? 'conflict' : 'failed' })
    }).finally(() => {
      if (epoch === epochRef.current) setPending({ scope, value: false })
    })
  }, [isPending, onAccepted, scope, selectedJobId, sessionId])

  return (
    <section aria-label={copy.title} data-selected-job-preparation="true" style={sectionStyle}>
      <h3 style={headingStyle}>{copy.title}</h3>
      <p style={hintStyle}>{copy.disclaimer}</p>
      <label style={labelStyle}>
        {copy.jobLabel}
        <select value={selectedJobId} onChange={event => setSelection({ scope, value: event.target.value })} disabled={loadingJobs || jobsError || jobs.length === 0} style={selectStyle}>
          <option value="">{loadingJobs ? copy.loading : jobsError ? copy.unavailable : copy.choose}</option>
          {jobs.map(job => <option key={job.id} value={job.id}>{job.company} · {job.role}</option>)}
        </select>
      </label>
      <button type="button" onClick={startPreparation} disabled={!selectedJobId || loadingJobs || jobsError || isPending} style={buttonStyle}>
        {isPending ? copy.starting : copy.start}
      </button>
      {currentFeedback === 'accepted' && <p role="status" style={hintStyle}>{copy.accepted}</p>}
      {currentFeedback === 'conflict' && <p role="alert" style={errorStyle}>{copy.conflict}</p>}
      {currentFeedback === 'failed' && <p role="alert" style={errorStyle}>{copy.failed}</p>}
    </section>
  )
}

function parseSavedJobs(value: unknown): SavedJob[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 100).flatMap(entry => {
    const row = record(entry)
    if (row.status !== 'saved' || !safeText(row.id, 256) || !safeText(row.company, 160) || !safeText(row.role, 160)) return []
    return [{ id: row.id, company: row.company, role: row.role }]
  })
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function safeText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value
}

function localized(lang: string) {
  return lang === 'zh'
    ? { title: '为单个职位准备草稿', disclaimer: '仅创建求职信草稿，不会提交申请或联系雇主。', jobLabel: '已保存的职位', loading: '正在加载职位…', unavailable: '职位暂时不可用', choose: '选择职位', start: '准备草稿', starting: '正在启动…', accepted: '准备任务已启动。草稿完成后会显示在此处。', conflict: '当前会话正在处理其他任务。完成后再试。', failed: '无法启动草稿准备，请重试。' }
    : { title: 'Prepare a draft for one job', disclaimer: 'Draft only. This will not submit an application or contact the employer.', jobLabel: 'Saved job', loading: 'Loading saved jobs…', unavailable: 'Saved jobs are unavailable', choose: 'Choose a job', start: 'Prepare draft', starting: 'Starting…', accepted: 'Preparation started. The draft will appear here when ready.', conflict: 'This session is handling another task. Try again when it is finished.', failed: 'Could not start draft preparation. Please try again.' }
}

const sectionStyle: React.CSSProperties = { display: 'grid', gap: 7, margin: '10px 0', padding: '10px 0', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }
const headingStyle: React.CSSProperties = { margin: 0, color: 'var(--text)', fontSize: 12 }
const hintStyle: React.CSSProperties = { margin: 0, color: 'var(--text-muted)', fontSize: 10, lineHeight: 1.45 }
const labelStyle: React.CSSProperties = { display: 'grid', gap: 4, color: 'var(--text-muted)', fontSize: 10 }
const selectStyle: React.CSSProperties = { width: '100%', minWidth: 0, border: '1px solid var(--border)', borderRadius: 6, padding: '7px', background: 'var(--bg)', color: 'var(--text)', font: 'inherit' }
const buttonStyle: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 7, padding: '7px 10px', color: 'var(--text)', background: 'var(--bg-secondary)', cursor: 'pointer', font: 'inherit', fontSize: 11, fontWeight: 650 }
const errorStyle: React.CSSProperties = { ...hintStyle, color: 'var(--c-danger)' }
