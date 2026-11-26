'use client'

import React, { useRef, useState } from 'react'
import {
  OBJECTIVE_APPLICATION_REVIEW_INTENT_SCHEMA, OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_V3_SCHEMA,
  parseObjectiveApplicationReviewIntent, sha256Hex,
  type ObjectiveTailorFinalOutcomeSidecarStatus, type ObjectiveTailorFinalOutcomeSidecarV2,
} from '@jobcopilot/agent-protocol'
import { parseObjectiveTailorFinalOutcomesFromContent } from '@/lib/agent/session/objective-tailor-final-content'
import { readObjectiveTailorSourceGroups } from '@/lib/agent/session/objective-tailor-source-groups'
import { parseFinalTaskGraphSourceManifest } from '@/lib/agent/session/final-task-graph-source-manifest'
import type { Lang } from '@/lib/i18n'
import type { ObjectiveTailorSourceGroup } from './FinalTaskGraphSources'
import { ObjectiveJourneyReport } from './ObjectiveJourneyReport'

const LABELS: Record<ObjectiveTailorFinalOutcomeSidecarStatus, Readonly<{ en: string; zh: string }>> = {
  ready: { en: 'Ready', zh: '已就绪' }, needs_revision: { en: 'Needs revision', zh: '需要修改' },
  rejected: { en: 'Rejected', zh: '未通过' }, stale: { en: 'Out of date', zh: '已过期' }, failed: { en: 'Failed', zh: '失败' },
}
type RequestState = 'pending' | 'accepted' | 'failed'
type SelectionState = Readonly<{ identity: string; ordinals: readonly number[] }>

export function ObjectiveTailorFinalOutcomes({ content, lang, sessionId, sourceTurnId, rootTaskId, finalItemId, relatedTaskSourcesId,
  onSourceGroupSelect, onSourceGroupReset }: {
  content: unknown; lang: Lang; sessionId?: string; sourceTurnId?: string; rootTaskId?: string | null; finalItemId?: string
  relatedTaskSourcesId?: string
  onSourceGroupSelect?: (group: ObjectiveTailorSourceGroup, sourceKeys: readonly string[], graphRevision: number) => void
  onSourceGroupReset?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const sidecar = parseObjectiveTailorFinalOutcomesFromContent(content)
  const contentRow = record(content), manifest = parseFinalTaskGraphSourceManifest(contentRow?.taskGraphSources)
  const graphRevision = manifest?.graphRevision ?? null
  const sourceGroups = readObjectiveTailorSourceGroups(contentRow?.objectiveTailorSourceGroups, manifest, sidecar)
  const identity = JSON.stringify([sessionId ?? null, sourceTurnId ?? null, rootTaskId ?? null, graphRevision])
  const [selection, setSelection] = useState<SelectionState>({ identity: '', ordinals: [] })
  const [requestState, setRequestState] = useState<{ identity: string; status: RequestState } | null>(null)
  const requestKeys = useRef(new Map<string, string>())
  const pendingIntent = useRef<string | null>(null)
  const currentIntent = useRef('')
  const ordinals = selection.identity === identity ? selection.ordinals : []
  const intentKey = JSON.stringify([identity, ordinals])
  currentIntent.current = intentKey
  const canRequest = Boolean(graphRevision && safeId(sessionId) && safeId(sourceTurnId) && safeId(rootTaskId))
  const copy = lang === 'zh' ? zh : en

  const select = (ordinal: number, checked: boolean) => {
    setSelection(previous => {
      const current = previous.identity === identity ? [...previous.ordinals] : []
      const next = checked ? [...new Set([...current, ordinal])].sort((left, right) => left - right)
        : current.filter(value => value !== ordinal)
      return { identity, ordinals: next }
    })
    setRequestState(null)
  }
  const requestReview = async () => {
    if (!sidecar || !canRequest || !graphRevision || !sessionId || !sourceTurnId || !rootTaskId
      || ordinals.length === 0 || pendingIntent.current === intentKey) return
    pendingIntent.current = intentKey
    setRequestState({ identity, status: 'pending' })
    try {
      const graphItemId = 'task-graph-' + await sha256Hex(rootTaskId)
      const selected = buildObjectiveApplicationReviewSelection({ sourceTurnId, rootTaskId, graphItemId, graphRevision, slotOrdinals: ordinals })
      if (!selected) throw new Error('invalid selection')
      let idempotencyKey = requestKeys.current.get(intentKey)
      if (!idempotencyKey) {
        idempotencyKey = objectiveReviewCommandKeyForIntent(requestKeys.current, intentKey)
      }
      const response = await fetch('/api/agent/sessions/' + encodeURIComponent(sessionId) + '/objective-application-review', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idempotencyKey, selection: selected }),
      })
      const result = await response.json().catch(() => null) as unknown
      if (!response.ok || !validCommandResult(result)) throw new Error('review request failed')
      requestKeys.current.delete(intentKey)
      if (currentIntent.current === intentKey) {
        setSelection({ identity, ordinals: [] })
        setRequestState({ identity, status: 'accepted' })
      }
    } catch {
      if (currentIntent.current === intentKey) setRequestState({ identity, status: 'failed' })
    } finally { if (pendingIntent.current === intentKey) pendingIntent.current = null }
  }

  if (!sidecar) return null
  const status = requestState?.identity === identity ? requestState.status : null
  const versionedSidecar = "sourceCounts" in sidecar ? sidecar : undefined
  const v3Sidecar = sidecar.schemaVersion === OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_V3_SCHEMA ? sidecar : undefined
  const sourceCounts = versionedSidecar?.sourceCounts
  const canNavigateToSources = Boolean(sourceCounts && safeId(finalItemId) && safeId(relatedTaskSourcesId))
  const reportedScoreFloor = v3Sidecar?.reportedScoreFloor
  const journeyReport = manifest && (!versionedSidecar || versionedSidecar.graphRevision === manifest.graphRevision)
    && safeId(sessionId) && safeId(finalItemId)
    ? <ObjectiveJourneyReport sessionId={sessionId} finalItemId={finalItemId} graphRevision={manifest.graphRevision}
      sourceCounts={sourceCounts} reportedScoreFloor={reportedScoreFloor}
      slots={sidecar.slots.map(slot => ({ ordinal: slot.ordinal, tailoringStatus: slot.status }))}
      lang={lang} enabled={expanded} />
    : null
  return <details aria-label={copy.heading} data-agent-objective-tailor-final-outcomes='true'
    onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{copy.heading}</summary>
    {sourceCounts && <section aria-label={copy.sourceCounts} data-objective-source-counts="true">
      <h3>{copy.sourceCounts}</h3>
      <dl>
        <div><dt>{copy.foundJobs}</dt><dd>{sourceCountLabel(sourceCounts.discoveredJobs, lang)}
          {sourceGroups && canNavigateToSources && sourceGroupAction('discoveredJobs', sourceCounts.discoveredJobs,
            sourceGroups.groups.discoveredJobs, copy.showDiscoveredJobs, onSourceGroupSelect, sourceGroups.graphRevision, relatedTaskSourcesId)}</dd></div>
        <div><dt>{copy.analyzedJobs}</dt><dd>{sourceCountLabel(sourceCounts.analyzedJobs, lang)}
          {sourceGroups && canNavigateToSources && sourceGroupAction('analyzedJobs', sourceCounts.analyzedJobs,
            sourceGroups.groups.analyzedJobs, copy.showAnalyzedJobs, onSourceGroupSelect, sourceGroups.graphRevision, relatedTaskSourcesId)}</dd></div>
      </dl>
      {canNavigateToSources && <a href={`#${relatedTaskSourcesId}`} onClick={() => onSourceGroupReset?.()}>{copy.relatedEvidence}</a>}
    </section>}
    <ul>{sidecar.slots.map(slot => <li key={slot.ordinal} data-tailor-outcome={slot.status}>
      {copy.job} {slot.ordinal}: {LABELS[slot.status][lang === 'zh' ? 'zh' : 'en']}
      {slot.status === 'ready' && canRequest && <label style={choiceStyle}>
        <input type='checkbox' checked={ordinals.includes(slot.ordinal)} onChange={event => select(slot.ordinal, event.target.checked)} />
        {copy.select} {copy.job.toLowerCase()} {slot.ordinal}
      </label>}
    </li>)}</ul>
    {canRequest && sidecar.slots.some(slot => slot.status === 'ready') && <div style={requestStyle}>
      <button type='button' disabled={ordinals.length === 0 || status === 'pending'} onClick={() => void requestReview()}>
        {status === 'pending' ? copy.requesting : copy.request}
      </button>
      {status === 'accepted' && <p role='status'>{copy.accepted}</p>}
      {status === 'failed' && <p role='alert'>{copy.failed}</p>}
    </div>}
    {journeyReport}
  </details>
}

function sourceCountLabel(count: ObjectiveTailorFinalOutcomeSidecarV2['sourceCounts']['discoveredJobs'], lang: Lang) {
  if (count.coverage === 'unavailable') return lang === 'zh' ? '不可用' : 'Unavailable'
  if (count.coverage === 'not_requested') return lang === 'zh' ? '未请求' : 'Not requested'
  if (count.coverage === 'partial') return lang === 'zh'
    ? `至少 ${count.knownCount}（部分覆盖）`
    : `At least ${count.knownCount} (partial coverage)`
  return lang === 'zh' ? `${count.knownCount}（完整覆盖）` : `${count.knownCount} (complete coverage)`
}

function sourceGroupAction(group: ObjectiveTailorSourceGroup,
  count: ObjectiveTailorFinalOutcomeSidecarV2['sourceCounts']['discoveredJobs'], sourceKeys: readonly string[],
  label: string, onSelect: ((group: ObjectiveTailorSourceGroup, sourceKeys: readonly string[], graphRevision: number) => void) | undefined,
  graphRevision: number, targetId?: string) {
  if (!onSelect || count.knownCount === null || count.knownCount <= 0 || sourceKeys.length === 0
    || count.coverage === 'unavailable' || count.coverage === 'not_requested' || !targetId) return null
  return <button type="button" data-objective-source-group-action={group} aria-controls={targetId}
    aria-label={label} onClick={() => onSelect(group, sourceKeys, graphRevision)} style={sourceGroupActionStyle}>{label}</button>
}

export function buildObjectiveApplicationReviewSelection(input: {
  sourceTurnId: string; rootTaskId: string; graphItemId: string; graphRevision: number; slotOrdinals: readonly number[]
}) {
  return parseObjectiveApplicationReviewIntent({ schema: OBJECTIVE_APPLICATION_REVIEW_INTENT_SCHEMA,
    ...input, slotOrdinals: [...input.slotOrdinals].sort((left, right) => left - right) })
}

export function objectiveReviewCommandKeyForIntent(keys: Map<string, string>, intentKey: string): string {
  const current = keys.get(intentKey)
  if (current) return current
  const randomId = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID()
    : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
  const next = 'objective-review-command-' + randomId
  keys.set(intentKey, next)
  return next
}

function validCommandResult(value: unknown): boolean {
  const row = record(value)
  return Boolean(row && Object.keys(row).sort().join(',') === 'disposition,turnId'
    && safeId(row.turnId) && (row.disposition === 'started' || row.disposition === 'duplicate'))
}
function safeId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) }
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try { return Object.getPrototypeOf(value) === Object.prototype ? value as Record<string, unknown> : null } catch { return null }
}
const en = { heading: 'Tailoring outcomes', job: 'Job', select: 'Select', request: 'Request application review',
  requesting: 'Starting review…', accepted: 'Review request started.', failed: 'Could not start review. Retry to safely check the same request.',
  sourceCounts: 'Source counts', foundJobs: 'Found jobs', analyzedJobs: 'Analyzed jobs', relatedEvidence: 'View related task evidence',
  showDiscoveredJobs: 'View discovery evidence', showAnalyzedJobs: 'View analysis evidence' }
const zh = { heading: '职位定制结果', job: '职位', select: '选择', request: '请求申请审核',
  requesting: '正在发起审核…', accepted: '审核请求已开始。', failed: '无法发起审核。重试会安全地检查同一请求。',
  sourceCounts: '来源统计', foundJobs: '已发现职位', analyzedJobs: '已分析职位', relatedEvidence: '查看相关任务证据',
  showDiscoveredJobs: '查看发现证据', showAnalyzedJobs: '查看分析证据' }
const choiceStyle: React.CSSProperties = { display: 'inline-flex', gap: 4, marginLeft: 8, alignItems: 'center' }
const requestStyle: React.CSSProperties = { display: 'grid', justifyItems: 'start', gap: 4 }
const sourceGroupActionStyle: React.CSSProperties = { marginLeft: 8, border: '1px solid var(--primary)', borderRadius: 5, padding: '2px 6px', background: 'transparent', color: 'var(--primary)', cursor: 'pointer', font: 'inherit', fontSize: 10 }
