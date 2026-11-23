'use client'

import React, { useRef, useState } from 'react'

import { VERIFIED_SHORTLIST_SELECTION_SCHEMA, parseVerifiedShortlistSelectionBinding, type VerifiedShortlistSourceIdentity } from '@jobcopilot/agent-protocol'
import type { Lang } from '@/lib/i18n'
import type { TaskGraphIdentity } from './task-graph-plan-query'

interface VerifiedShortlistItem { readonly jobId: string; readonly score: number; readonly evidenceIds: readonly string[] }
interface VerifiedShortlistResult {
  readonly schemaVersion: 1
  readonly status: 'completed' | 'partial' | 'failed'
  readonly items: readonly VerifiedShortlistItem[]
  readonly failures: readonly string[]
}

export interface VerifiedShortlistPreparationRequest {
  readonly source: VerifiedShortlistSourceIdentity
  readonly selectedJobIds: readonly string[]
}

type PrepareShortlist = (request: VerifiedShortlistPreparationRequest) => Promise<unknown> | unknown

export function VerifiedShortlistPreparation({ sessionId, identity, value, lang, onPrepare }: {
  readonly sessionId: string
  readonly identity: TaskGraphIdentity | null
  readonly value: unknown
  readonly lang: Lang
  readonly onPrepare?: PrepareShortlist
}) {
  const activeIdentity = parseIdentity(identity)
  const response = parseShortlistResponse(value)
  if (!activeIdentity || activeIdentity.sessionId !== sessionId || !response || !sameIdentity(response.identity, activeIdentity)) return null
  return <VerifiedShortlistDisplay
    key={JSON.stringify([activeIdentity.sessionId, activeIdentity.turnId, activeIdentity.rootTaskId, activeIdentity.graphItemId, activeIdentity.revision])}
    identity={activeIdentity}
    result={response.result}
    lang={lang}
    onPrepare={onPrepare}
  />
}

function VerifiedShortlistDisplay({ identity, result, lang, onPrepare }: {
  readonly identity: TaskGraphIdentity
  readonly result: VerifiedShortlistResult
  readonly lang: Lang
  readonly onPrepare?: PrepareShortlist
}) {
  const copy = lang === 'zh'
    ? { title: '职位候选清单', completed: '已完成', partial: '部分结果', failed: '失败', completedDetail: '已从此会话恢复已验证的职位。', partialDetail: '部分发现检查未完成。', failedDetail: '没有可恢复的已验证匹配。', score: '匹配分', evidence: '证据来源', checks: '检查状态', select: '选择职位', selected: '已选', prepare: '准备所选职位', preparing: '正在处理所选职位…', success: '请求已处理。', error: '无法处理请求，请重试。', range: '请选择 2 至 3 个职位。' }
    : { title: 'Discovery shortlist', completed: 'Completed', partial: 'Partial results', failed: 'Failed', completedDetail: 'Validated matches recovered from this session.', partialDetail: 'Some discovery checks were incomplete.', failedDetail: 'No validated matches were recovered.', score: 'Score', evidence: 'Evidence references', checks: 'Checks', select: 'Select job', selected: 'Selected', prepare: 'Prepare selected jobs', preparing: 'Processing selected jobs…', success: 'Request processed.', error: 'Could not process the request. Please try again.', range: 'Select two or three jobs.' }
  const [selectedJobIds, setSelectedJobIds] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<'success' | 'error' | null>(null)
  const inFlight = useRef(false)
  const canSelect = Boolean(onPrepare && result.status === 'completed' && result.items.length >= 2 && result.items.length <= 3
    && buildVerifiedShortlistPreparationRequest(identity, result.items, result.items.slice(0, 2).map(item => item.jobId)))
  const orderedSelection = result.items.filter(item => selectedJobIds.includes(item.jobId)).map(item => item.jobId)

  const handlePrepare = async () => {
    if (!onPrepare || !canSelect || busy || inFlight.current || orderedSelection.length < 2 || orderedSelection.length > 3) return
    const request = buildVerifiedShortlistPreparationRequest(identity, result.items, orderedSelection)
    if (!request) return
    setBusy(true)
    setOutcome(null)
    try {
      if (await runShortlistPreparationOnce(inFlight, onPrepare, request)) setOutcome('success')
    } catch {
      setOutcome('error')
    } finally {
      setBusy(false)
    }
  }

  const statusLabel = result.status === 'completed' ? copy.completed : result.status === 'partial' ? copy.partial : copy.failed
  const detail = result.status === 'completed' ? copy.completedDetail : result.status === 'partial' ? copy.partialDetail : copy.failedDetail
  return (
    <section aria-label={copy.title} data-agent-discovery-shortlist="true" data-discovery-shortlist-status={result.status} style={sectionStyle}>
      <h3 style={headingStyle}>{copy.title}</h3>
      <p role={result.status === 'failed' ? 'alert' : 'status'} style={planGoalStyle}><strong>{statusLabel}:</strong> {detail}</p>
      {result.failures.length > 0 && <div data-discovery-failures="true" style={evidenceStyle}>
        <strong>{copy.checks}</strong>
        <ul style={evidenceListStyle}>{result.failures.map(code => <li key={code} data-discovery-failure-code={code}><code>{code}</code></li>)}</ul>
      </div>}
      {result.items.length > 0 && <ol style={listStyle}>{result.items.map(item => (
        <li key={item.jobId} data-discovery-job-id={item.jobId} style={nodeStyle}>
          <strong style={goalStyle}><code>{item.jobId}</code></strong>
          {canSelect && <label style={selectionStyle}>
            <input type="checkbox" aria-label={`${copy.select} ${item.jobId}`} checked={selectedJobIds.includes(item.jobId)} disabled={busy}
              onChange={() => {
                if (busy || inFlight.current) return
                setSelectedJobIds(current => current.includes(item.jobId) ? current.filter(selected => selected !== item.jobId)
                  : current.length < 3 ? [...current, item.jobId] : current)
                setOutcome(null)
              }} />
            <span>{copy.select}</span>
          </label>}
          <span>{copy.score}: {item.score} / 10</span>
          <span>{copy.evidence}: {item.evidenceIds.map(id => <code key={id}>{id}</code>)}</span>
        </li>
      ))}</ol>}
      {canSelect && <div data-verified-shortlist-controls="true" style={controlsStyle}>
        <span>{copy.selected}: {orderedSelection.length} / 3. {copy.range}</span>
        <button type="button" data-verified-shortlist-prepare="true" disabled={busy || inFlight.current || orderedSelection.length < 2 || orderedSelection.length > 3} onClick={handlePrepare} style={buttonStyle}>
          {busy ? copy.preparing : copy.prepare}
        </button>
        {outcome && <p role="status" aria-live="polite" data-verified-shortlist-result={outcome}>{outcome === 'success' ? copy.success : copy.error}</p>}
      </div>}
    </section>
  )
}

export function buildVerifiedShortlistPreparationRequest(
  identity: TaskGraphIdentity,
  items: readonly VerifiedShortlistItem[],
  selectedJobIds: readonly string[],
): VerifiedShortlistPreparationRequest | null {
  const selected = new Set(selectedJobIds)
  if (selected.size < 2 || selected.size > 3 || selected.size !== selectedJobIds.length) return null
  const jobIds = items.filter(item => selected.has(item.jobId)).map(item => item.jobId)
  if (jobIds.length !== selected.size) return null
  const binding = parseVerifiedShortlistSelectionBinding({
    schemaVersion: VERIFIED_SHORTLIST_SELECTION_SCHEMA,
    source: {
      sessionId: identity.sessionId,
      sourceTurnId: identity.turnId,
      rootTaskId: identity.rootTaskId,
      graphItemId: identity.graphItemId,
      graphRevision: identity.revision,
    },
    selectedJobIds: jobIds,
  })
  return binding ? { source: binding.source, selectedJobIds: binding.selectedJobIds } : null
}

export async function runShortlistPreparationOnce(
  lock: { current: boolean },
  onPrepare: PrepareShortlist,
  request: VerifiedShortlistPreparationRequest,
): Promise<boolean> {
  if (lock.current) return false
  lock.current = true
  try {
    await onPrepare(request)
    return true
  } finally {
    lock.current = false
  }
}

function parseShortlistResponse(value: unknown): { readonly identity: TaskGraphIdentity; readonly result: VerifiedShortlistResult } | null {
  const response = record(value)
  const identity = response ? parseIdentity(response.identity) : null
  const result = response ? record(response.result) : null
  if (!response || Object.keys(response).length !== 2 || !identity || !result
    || Object.keys(result).length !== 4 || result.schemaVersion !== 1
    || (result.status !== 'completed' && result.status !== 'partial' && result.status !== 'failed')
    || !Array.isArray(result.items) || result.items.length > 3 || !Array.isArray(result.failures) || result.failures.length > DISCOVERY_FAILURE_CODES.size) return null
  const items: VerifiedShortlistItem[] = []
  const jobIds = new Set<string>()
  for (const value of result.items) {
    const item = record(value)
    if (!item || Object.keys(item).length !== 3 || typeof item.jobId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(item.jobId) || jobIds.has(item.jobId)
      || typeof item.score !== 'number' || !Number.isFinite(item.score) || item.score < 0 || item.score > 10
      || !Array.isArray(item.evidenceIds) || item.evidenceIds.length !== 1 || item.evidenceIds[0] !== `read:job:${item.jobId}`) return null
    jobIds.add(item.jobId)
    items.push({ jobId: item.jobId, score: item.score, evidenceIds: [`read:job:${item.jobId}`] })
  }
  const failures = result.failures
  if (failures.some(code => typeof code !== 'string' || !DISCOVERY_FAILURE_CODES.has(code)) || new Set(failures).size !== failures.length) return null
  const validState = result.status === 'completed' ? items.length > 0 && failures.length === 0
    : result.status === 'partial' ? items.length > 0 && failures.length > 0 : items.length === 0 && failures.length > 0
  return validState ? { identity, result: { schemaVersion: 1, status: result.status, items, failures } } : null
}

function parseIdentity(value: unknown): TaskGraphIdentity | null {
  const identity = record(value)
  if (!identity || Object.keys(identity).sort().join(',') !== 'graphItemId,revision,rootTaskId,sessionId,turnId'
    || ![identity.sessionId, identity.graphItemId, identity.turnId, identity.rootTaskId].every(value => boundedIdentifier(value))
    || !Number.isSafeInteger(identity.revision) || Number(identity.revision) < 1) return null
  return {
    sessionId: identity.sessionId as string, graphItemId: identity.graphItemId as string,
    turnId: identity.turnId as string, rootTaskId: identity.rootTaskId as string, revision: Number(identity.revision),
  }
}

const DISCOVERY_FAILURE_CODES = new Set([
  'owner_scope_missing', 'observed_evidence_invalid', 'invalid_scout_result', 'invalid_analyst_result',
  'scout_task_missing', 'analyst_task_missing', 'scout_task_failed', 'analyst_task_failed', 'scout_task_incomplete', 'analyst_task_incomplete',
  'scout_result_partial', 'analyst_result_partial', 'evidence_conflict', 'evidence_unverified', 'invalid_job_id',
  'duplicate_scout_job', 'duplicate_analyst_finding', 'conflicting_analyst_score', 'no_common_candidates',
  'discovery_runtime_unavailable', 'discovery_runtime_failed',
])

function sameIdentity(left: TaskGraphIdentity, right: TaskGraphIdentity): boolean {
  return left.sessionId === right.sessionId && left.graphItemId === right.graphItemId && left.turnId === right.turnId
    && left.rootTaskId === right.rootTaskId && left.revision === right.revision
}

function boundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

const sectionStyle: React.CSSProperties = { display: 'grid', gap: 7, margin: '10px 0', padding: '9px 0', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 10, lineHeight: 1.45 }
const headingStyle: React.CSSProperties = { margin: 0, color: 'var(--text)', fontSize: 12 }
const planGoalStyle: React.CSSProperties = { margin: 0, color: 'var(--text)', fontSize: 11, fontWeight: 650, overflowWrap: 'anywhere' }
const listStyle: React.CSSProperties = { display: 'grid', gap: 8, margin: 0, paddingLeft: 18 }
const nodeStyle: React.CSSProperties = { display: 'grid', gap: 3, minWidth: 0, overflowWrap: 'anywhere' }
const goalStyle: React.CSSProperties = { color: 'var(--text)', fontSize: 11 }
const evidenceStyle: React.CSSProperties = { display: 'grid', gap: 2, borderLeft: '2px solid var(--border)', paddingLeft: 6, overflowWrap: 'anywhere' }
const evidenceListStyle: React.CSSProperties = { display: 'grid', gap: 2, margin: 0, paddingLeft: 16 }
const controlsStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const selectionStyle: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, width: 'fit-content' }
const buttonStyle: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 4, padding: '4px 8px', background: 'var(--surface)', color: 'var(--text)', font: 'inherit', cursor: 'pointer' }
