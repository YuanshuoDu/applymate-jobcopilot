'use client'

import React, { useEffect, useMemo, useRef } from 'react'

import { useApi } from '@/lib/hooks'
import { useI18n } from '@/lib/i18n'
import {
  parseObjectiveTailorProgress,
  parseObjectiveTailorProgressHint,
} from '@/lib/agent/session/objective-tailor-progress-contract'
import type { TimelineItem } from './timeline-reducer'
import { latestTaskGraphItem } from './task-graph-plan-query'

const ACTIVE_TURN_STATUSES = new Set(['queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user'])

export interface ObjectiveTailorProgressIdentity {
  readonly sessionId: string
  readonly turnId: string
  readonly graphItemId: string
  readonly rootTaskId: string
  readonly revision: number
}

export interface ObjectiveTailorProgressRequest {
  readonly identity: ObjectiveTailorProgressIdentity
  readonly sourceNodeCount: number
  readonly slotCount: number
}

export function objectiveTailorProgressRequestForItem(
  item: TimelineItem | null,
  sessionId: string,
  turnId: string,
): ObjectiveTailorProgressRequest | null {
  if (!item || item.type !== 'task_graph' || item.schemaVersion !== 'agent-harness.v2'
    || item.sessionId !== sessionId || item.turnId !== turnId || !safeId(item.id) || !safeId(item.taskId)
    || !Number.isSafeInteger(item.revision) || item.revision < 1) return null
  const content = ownRecord(item.content)
  const descriptor = content && Object.getOwnPropertyDescriptor(content, 'objectiveTailorProgressHint')
  const hint = descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
    ? parseObjectiveTailorProgressHint(descriptor.value) : undefined
  if (!hint) return null
  return {
    identity: { sessionId, turnId, graphItemId: item.id, rootTaskId: item.taskId, revision: item.revision },
    sourceNodeCount: hint.sourceNodeCount,
    slotCount: hint.slotCount,
  }
}

export function objectiveTailorTurnForCurrentView(projection: unknown, fallbackTurnId: string | null): string | null {
  if (projection === undefined) return safeId(fallbackTurnId) ? fallbackTurnId : null
  const row = ownRecord(projection)
  if (!row || row.activeTurnId === null && row.activeTurn === null) return null
  const active = ownRecord(row.activeTurn)
  return safeId(row.activeTurnId) && active?.id === row.activeTurnId && typeof active.status === 'string'
    && ACTIVE_TURN_STATUSES.has(active.status) ? row.activeTurnId : null
}

export function objectiveTailorProgressRequestForTurn(
  items: readonly TimelineItem[],
  sessionId: string,
  turnId: string | null,
): ObjectiveTailorProgressRequest | null {
  if (!safeId(turnId)) return null
  return objectiveTailorProgressRequestForItem(latestTaskGraphItem(items, sessionId, turnId), sessionId, turnId)
}

export function buildObjectiveTailorProgressUrl(identity: ObjectiveTailorProgressIdentity): string {
  const query = new URLSearchParams([
    ['graphItemId', identity.graphItemId],
    ['turnId', identity.turnId],
    ['rootTaskId', identity.rootTaskId],
    ['revision', String(identity.revision)],
  ])
  return `/api/agent/sessions/${encodeURIComponent(identity.sessionId)}/objective-tailor-progress?${query.toString()}`
}

export function shouldRefetchObjectiveTailorProgress(previous: number, next: number, enabled: boolean): boolean {
  return enabled && Number.isSafeInteger(previous) && previous >= 0 && Number.isSafeInteger(next) && next >= 0 && previous !== next
}

export function ObjectiveTailorProgress({ request, lifecycleRevision }: {
  readonly request: ObjectiveTailorProgressRequest
  readonly lifecycleRevision: number
}) {
  const { lang } = useI18n()
  const url = useMemo(() => buildObjectiveTailorProgressUrl(request.identity), [request.identity])
  const query = useApi<unknown>(url, { enabled: true, cache: false })
  const revision = Number.isSafeInteger(lifecycleRevision) && lifecycleRevision >= 0 ? lifecycleRevision : 0
  const lastRefresh = useRef({ revision, url })
  useEffect(() => {
    const previous = lastRefresh.current
    lastRefresh.current = { revision, url }
    if (previous.url === url && shouldRefetchObjectiveTailorProgress(previous.revision, revision, Boolean(url))) void query.refetch()
  }, [query.refetch, revision, url])

  const body = ownRecord(query.data)
  const parsed = body ? parseObjectiveTailorProgress(body.progress) : undefined
  const progress = !query.error && parsed && sameIdentity(parsed.identity, request.identity)
    && parsed.sources.length === request.sourceNodeCount && parsed.slots.length === request.slotCount ? parsed : null
  const copy = lang === 'zh' ? chineseCopy : englishCopy
  if (!progress) return <section role="status" data-objective-tailor-progress="unavailable" style={sectionStyle}>
    <h2 style={headingStyle}>{copy.title}</h2>
    <p style={hintStyle}>{!query.error && query.loading ? copy.loading : copy.unavailable}</p>
  </section>

  const completed = progress.slots.filter(slot => slot.phase === 'completed').length
  return <section aria-label={copy.title} data-objective-tailor-progress="available" style={sectionStyle}>
    <h2 style={headingStyle}>{copy.title}</h2>
    <p role="status" style={hintStyle}>{copy.reviewComplete}: {completed}/{progress.slots.length}</p>
    <details>
      <summary>{copy.details}</summary>
      <h3 style={subheadingStyle}>{copy.sources}</h3>
      <ul style={listStyle}>
        {progress.sources.map(source => <li key={`source-${source.ordinal}`} data-source-status={source.status}>
          {source.role === 'scout' ? copy.scout : copy.analyst} {source.ordinal}: {copy.sourceStatus[source.status]}
        </li>)}
      </ul>
      <h3 style={subheadingStyle}>{copy.slots}</h3>
      <ul style={listStyle}>
        {progress.slots.map(slot => <li key={`slot-${slot.ordinal}`} data-slot-phase={slot.phase}>
          {copy.slot} {slot.ordinal}: {copy.slotPhase[slot.phase]}
        </li>)}
      </ul>
    </details>
  </section>
}

function sameIdentity(left: ObjectiveTailorProgressIdentity, right: ObjectiveTailorProgressIdentity): boolean {
  return left.sessionId === right.sessionId && left.turnId === right.turnId && left.graphItemId === right.graphItemId
    && left.rootTaskId === right.rootTaskId && left.revision === right.revision
}

function ownRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  return value as Record<string, unknown>
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

const englishCopy = {
  title: 'Objective tailoring progress', loading: 'Loading progress…', unavailable: 'Progress is unavailable.',
  reviewComplete: 'Reviews complete', details: 'Show source and slot progress', sources: 'Research tasks', slots: 'Draft and review slots',
  scout: 'Scout', analyst: 'Analyst', slot: 'Slot',
  sourceStatus: { pending: 'Waiting', running: 'In progress', completed: 'Completed', failed: 'Failed' },
  slotPhase: {
    awaiting_draft: 'Waiting to draft', drafting: 'Drafting', awaiting_review: 'Waiting for review', reviewing: 'Reviewing',
    awaiting_revision: 'Waiting for correction', revising: 'Correcting', awaiting_rereview: 'Waiting for re-review',
    rereviewing: 'Reviewing correction', completed: 'Review complete', failed: 'Failed',
  },
}
const chineseCopy = {
  title: '目标定制进度', loading: '正在读取进度…', unavailable: '暂时无法读取进度。',
  reviewComplete: '已完成审核', details: '查看研究与职位进度', sources: '研究任务', slots: '草稿与审核',
  scout: '调研', analyst: '分析', slot: '职位',
  sourceStatus: { pending: '等待中', running: '进行中', completed: '已完成', failed: '失败' },
  slotPhase: {
    awaiting_draft: '等待起草', drafting: '正在起草', awaiting_review: '等待审核', reviewing: '正在审核',
    awaiting_revision: '等待修改', revising: '正在修改', awaiting_rereview: '等待复审',
    rereviewing: '正在复审', completed: '审核完成', failed: '失败',
  },
}
const sectionStyle: React.CSSProperties = { display: 'grid', gap: 6, color: 'var(--text)' }
const headingStyle: React.CSSProperties = { margin: 0, fontSize: 13 }
const subheadingStyle: React.CSSProperties = { margin: '8px 0 2px', fontSize: 11 }
const listStyle: React.CSSProperties = { margin: 0, paddingLeft: 22, color: 'var(--text-muted)', fontSize: 11 }
const hintStyle: React.CSSProperties = { margin: 0, color: 'var(--text-muted)', fontSize: 11 }
