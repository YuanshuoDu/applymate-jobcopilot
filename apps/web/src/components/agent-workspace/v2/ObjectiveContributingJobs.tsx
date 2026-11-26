'use client'

import React from 'react'
import { parseObjectiveJobEvidence, type ObjectiveJobEvidence, type ObjectiveJobEvidenceGroup } from '@/lib/agent/session/objective-job-evidence-contract'
import type { Lang } from '@/lib/i18n'

export type ObjectiveJobEvidenceGroupKey = ObjectiveJobEvidenceGroup
type Coverage = 'complete' | 'partial'
export type ObjectiveContributingJobsRequest = Readonly<{
  sessionId: string
  finalItemId: string
  group: ObjectiveJobEvidenceGroupKey
  graphRevision: number
  sourceKeys: readonly string[]
  expectedCount: number
  expectedCoverage: Coverage
  lang: Lang
}>
type LoadState = Readonly<{ identity: string; state: 'idle' | 'loading' | 'unavailable' }> | Readonly<{
  identity: string; state: 'ready'; evidence: ObjectiveJobEvidence
}>

export function ObjectiveContributingJobs(request: ObjectiveContributingJobsRequest) {
  const identity = requestIdentity(request)
  const [loadState, setLoadState] = React.useState<LoadState>({ identity, state: 'idle' })
  const controllerRef = React.useRef<AbortController | null>(null)
  const copy = request.lang === 'zh' ? zh : en
  const current = loadState.identity === identity ? loadState : { identity, state: 'idle' as const }
  const evidenceId = React.useId()

  React.useEffect(() => {
    controllerRef.current?.abort()
    setLoadState({ identity, state: 'idle' })
    return () => controllerRef.current?.abort()
  }, [identity])

  const load = () => {
    if (current.state === 'loading') return
    if (current.state === 'ready') {
      setLoadState({ identity, state: 'idle' })
      return
    }
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setLoadState({ identity, state: 'loading' })
    void loadObjectiveJobEvidence(request, controller.signal).then(evidence => {
      if (controller.signal.aborted) return
      setLoadState(evidence ? { identity, state: 'ready', evidence } : { identity, state: 'unavailable' })
    })
  }

  return <section aria-label={copy.heading} data-objective-contributing-jobs="true" style={sectionStyle}>
    <button type="button" aria-expanded={current.state === 'ready'} aria-controls={`objective-job-evidence-${evidenceId}`}
      onClick={load} disabled={current.state === 'loading'} style={buttonStyle}>
      {current.state === 'ready' ? copy.hide : current.state === 'unavailable' ? copy.retry : copy.view}
    </button>
    <div id={`objective-job-evidence-${evidenceId}`} aria-busy={current.state === 'loading'}>
      {current.state === 'loading' && <p role="status" aria-live="polite">{copy.loading}</p>}
      {current.state === 'unavailable' && <p role="alert">{copy.unavailable}</p>}
      {current.state === 'ready' && <JobEvidence evidence={current.evidence} copy={copy} />}
    </div>
  </section>
}

export async function loadObjectiveJobEvidence(request: ObjectiveContributingJobsRequest, signal: AbortSignal,
  fetcher: typeof fetch = fetch): Promise<ObjectiveJobEvidence | null> {
  try {
    const response = await fetcher(objectiveJobEvidenceUrl(request.sessionId, request.finalItemId, request.group, request.graphRevision), {
      credentials: 'same-origin', cache: 'no-store', signal,
    })
    if (!response.ok) throw new Error('unavailable')
    const body = await response.json()
    if (signal.aborted) return null
    return parseObjectiveJobEvidenceResponse(body, request)
  } catch {
    return null
  }
}

export function parseObjectiveJobEvidenceResponse(value: unknown, request: ObjectiveContributingJobsRequest): ObjectiveJobEvidence | null {
  const root = record(value)
  if (!root || !exactKeys(root, ['jobEvidence'])) return null
  const evidence = parseObjectiveJobEvidence(root.jobEvidence)
  if (!evidence || evidence.group !== request.group || evidence.graphRevision !== request.graphRevision
    || evidence.coverage !== request.expectedCoverage || evidence.count !== request.expectedCount
    || evidence.jobs.length !== request.expectedCount || !sameSourceSet(evidence, request.sourceKeys)) return null
  return evidence
}

export function objectiveJobEvidenceUrl(sessionId: string, finalItemId: string, group: ObjectiveJobEvidenceGroupKey,
  graphRevision: number): string {
  return `/api/agent/sessions/${encodeURIComponent(sessionId)}/final-items/${encodeURIComponent(finalItemId)}/objective-job-groups/${encodeURIComponent(group)}?graphRevision=${encodeURIComponent(String(graphRevision))}`
}

function JobEvidence({ evidence, copy }: { evidence: ObjectiveJobEvidence; copy: Copy }) {
  return <>
    <p role="status">{evidence.jobs.length === 0 ? copy.empty : `${copy.coverage}: ${coverageLabel(evidence.coverage, copy)}`}</p>
    {evidence.jobs.length > 0 && <ul style={listStyle}>{evidence.jobs.map(job => <li key={job.ordinal} style={jobStyle}>
      <strong>{job.role}</strong> · {job.company}
      {job.location && <span> · {job.location}</span>}
      {job.postingUrl && <a href={job.postingUrl} target="_blank" rel="noreferrer" style={linkStyle}>{copy.open}</a>}
    </li>)}</ul>}
  </>
}

function sameSourceSet(evidence: ObjectiveJobEvidence, expected: readonly string[]): boolean {
  const expectedSet = new Set(expected)
  if (!expected.length || expectedSet.size !== expected.length) return false
  const returned = new Set<string>()
  for (const job of evidence.jobs) {
    if (!job.sourceKeys.length || new Set(job.sourceKeys).size !== job.sourceKeys.length) return false
    for (const key of job.sourceKeys) {
      if (!expectedSet.has(key)) return false
      returned.add(key)
    }
  }
  return returned.size === expectedSet.size && [...expectedSet].every(key => returned.has(key))
}

function requestIdentity(request: ObjectiveContributingJobsRequest): string {
  return JSON.stringify([request.sessionId, request.finalItemId, request.group, request.graphRevision, request.sourceKeys,
    request.expectedCount, request.expectedCoverage])
}
function coverageLabel(value: Coverage, copy: Copy): string { return value === 'complete' ? copy.complete : copy.partial }
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try { return Object.getPrototypeOf(value) === Object.prototype ? value as Record<string, unknown> : null } catch { return null }
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  try { const keys = Reflect.ownKeys(value); return keys.length === expected.length && keys.every(key => typeof key === 'string' && expected.includes(key)) }
  catch { return false }
}

type Copy = typeof en
const en = { heading: 'Saved jobs', view: 'View saved jobs', hide: 'Hide saved jobs', retry: 'Retry saved jobs',
  loading: 'Loading saved jobs…', unavailable: 'Saved job evidence is unavailable.', empty: 'No saved jobs are available.',
  coverage: 'Coverage', complete: 'complete', partial: 'partial', open: 'Open current posting' }
const zh = { heading: '已保存职位', view: '查看已保存职位', hide: '隐藏已保存职位', retry: '重试已保存职位',
  loading: '正在加载已保存职位…', unavailable: '已保存职位证据不可用。', empty: '没有可用的已保存职位。',
  coverage: '覆盖范围', complete: '完整', partial: '部分', open: '打开当前职位页面' }
const sectionStyle: React.CSSProperties = { display: 'grid', gap: 5, marginTop: 4 }
const buttonStyle: React.CSSProperties = { border: 0, padding: 0, background: 'transparent', color: 'var(--primary)', textAlign: 'left', cursor: 'pointer', font: 'inherit' }
const listStyle: React.CSSProperties = { display: 'grid', gap: 5, margin: 0, paddingLeft: 18 }
const jobStyle: React.CSSProperties = { color: 'var(--text)', overflowWrap: 'anywhere' }
const linkStyle: React.CSSProperties = { display: 'inline-block', marginLeft: 6, color: 'var(--primary)' }
