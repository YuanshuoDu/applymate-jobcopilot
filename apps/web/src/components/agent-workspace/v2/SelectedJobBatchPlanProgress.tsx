'use client'

import React, { useEffect, useMemo, useRef } from 'react'

import { useApi } from '@/lib/hooks'
import { useI18n } from '@/lib/i18n'
import type { SelectedJobBatchWorkbenchModel } from '@/lib/agent/session/selected-job-batch-workbench-read-model'

import type { TaskGraphIdentity } from './task-graph-plan-query'
import type { SupervisorTurnSummary } from './task-tree-projection'
import { SelectedJobBatchProgress } from './SelectedJobBatchProgress'

const ACTIVE_TURN_STATUSES = new Set(['queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user'])
const BRANCH_STATUSES = new Set(['pending', 'completed', 'failed'])
const BATCH_STATUSES = new Set(['pending', 'partial', 'completed', 'failed'])
const REVIEW_STATUSES = new Set(['passed', 'needs_revision', 'rejected', 'stale'])

export function resolveCurrentSelectedJobBatchTurn(turns: readonly SupervisorTurnSummary[], sessionId: string, projection: unknown) {
  if (projection === undefined) return latestBatchTurn(turns, sessionId)
  const active = projectedActiveTurn(turns, sessionId, projection)
  if (active.kind === 'invalid') return { turnId: null, activeTurnId: null }
  if (active.kind === 'present') return active.batch ? { turnId: active.id, activeTurnId: active.id } : { turnId: null, activeTurnId: null }
  return latestBatchTurn(turns, sessionId)
}

function projectedActiveTurn(turns: readonly SupervisorTurnSummary[], sessionId: string, value: unknown):
  | { kind: 'none' } | { kind: 'invalid' } | { kind: 'present'; id: string; batch: boolean } {
  const projection = record(value), active = record(projection?.activeTurn)
  const id = projection?.activeTurnId
  if (projection?.activeTurnId === null && projection.activeTurn === null) return { kind: 'none' }
  if (!safeId(id) || active?.id !== id || (active.sessionId !== undefined && active.sessionId !== sessionId)
    || typeof active.status !== 'string' || !ACTIVE_TURN_STATUSES.has(active.status)
    || typeof active.revision !== 'number' || !Number.isSafeInteger(active.revision) || active.revision < 0
    || Object.hasOwn(active, 'selectedJobBatchPreparation') && active.selectedJobBatchPreparation !== true) return { kind: 'invalid' }
  const listed = turns.filter(turn => turn.sessionId === sessionId && turn.id === id)
  const batch = active.selectedJobBatchPreparation === true
  if (listed.length > 1 || listed.length === 1 && (listed[0]?.selectedJobBatchPreparation === true) !== batch) return { kind: 'invalid' }
  return { kind: 'present', id, batch }
}

function latestBatchTurn(turns: readonly SupervisorTurnSummary[], sessionId: string) {
  const owned = turns.filter(turn => turn.sessionId === sessionId)
  // The turns API is oldest-first, and SupervisorPanel appends each later page.
  const latest = owned.at(-1)
  const turnId = latest && safeId(latest.id) && latest.selectedJobBatchPreparation === true ? latest.id : null
  return { turnId, activeTurnId: turnId && ACTIVE_TURN_STATUSES.has(latest?.status ?? '') ? turnId : null }
}

export function SelectedJobBatchPlanProgress({ sessionId, turnId, expectedGraph, active, lifecycleRevision }: {
  readonly sessionId: string
  readonly turnId: string | null
  readonly expectedGraph: TaskGraphIdentity | null
  readonly active: boolean
  readonly lifecycleRevision: number
}) {
  const { lang } = useI18n()
  const url = useMemo(() => sessionId && turnId
    ? `/api/agent/sessions/${encodeURIComponent(sessionId)}/selected-job-batches/${encodeURIComponent(turnId)}` : null, [sessionId, turnId])
  const query = useApi<unknown>(url ?? '', { enabled: Boolean(url), cache: false })
  const revision = Number.isSafeInteger(lifecycleRevision) && lifecycleRevision >= 0 ? lifecycleRevision : 0
  const lastRevision = useRef(revision)
  useEffect(() => {
    const previous = lastRevision.current
    lastRevision.current = revision
    if (shouldRefetchSelectedJobBatch(previous, revision, Boolean(url))) void query.refetch()
  }, [query.refetch, revision, url])

  if (!url || !turnId) return null
  const model = matchingModel(query.data, sessionId, turnId, expectedGraph, active)
  if (model) return <SelectedJobBatchProgress model={model} />
  const message = lang === 'zh'
    ? query.loading ? '正在读取所选职位进度…' : '所选职位进度暂不可用。'
    : query.loading ? 'Loading selected job progress…' : 'Selected job progress is unavailable.'
  return <p role="status" data-selected-job-batch-state={query.loading ? 'loading' : 'unavailable'} style={messageStyle}>{message}</p>
}

export function shouldRefetchSelectedJobBatch(previous: number, next: number, enabled: boolean): boolean {
  return enabled && Number.isSafeInteger(previous) && previous >= 0 && Number.isSafeInteger(next) && next >= 0 && previous !== next
}

function matchingModel(value: unknown, sessionId: string, turnId: string, expected: TaskGraphIdentity | null, active: boolean): SelectedJobBatchWorkbenchModel | null {
  const model = record(value), source = record(model?.source), status = model?.status
  const graph = model?.graph === null ? null : record(model?.graph)
  if (!model || model.sessionId !== sessionId || model.turnId !== turnId || typeof status !== 'string' || !BATCH_STATUSES.has(status)
    || !sourceIdentityMatches(source, sessionId) || !Array.isArray(model.jobs) || !model.jobs.length || !model.jobs.every(validJob)) return null
  if (expected) {
    if (expected.sessionId !== sessionId || expected.turnId !== turnId || !graphMatches(graph, expected)) return null
  } else if (!(active && model.graph === null && status === 'pending')) return null
  return model as unknown as SelectedJobBatchWorkbenchModel
}

function sourceIdentityMatches(source: Record<string, unknown> | null, sessionId: string): boolean {
  return Boolean(source && source.sessionId === sessionId && safeId(source.sourceTurnId) && safeId(source.rootTaskId)
    && safeId(source.graphItemId) && Number.isSafeInteger(source.graphRevision) && Number(source.graphRevision) > 0)
}

function graphMatches(graph: Record<string, unknown> | null, expected: TaskGraphIdentity): boolean {
  return Boolean(graph && graph.itemId === expected.graphItemId && graph.rootTaskId === expected.rootTaskId
    && graph.revision === expected.revision && Number.isSafeInteger(graph.revision) && Number(graph.revision) > 0)
}

function validJob(value: unknown): boolean {
  const job = record(value), writer = record(job?.writer), reviewer = record(job?.reviewer)
  return Boolean(job && safeId(job.slotId) && safeId(job.jobId) && boundedLabel(job.company) && boundedLabel(job.role)
    && typeof job.status === 'string' && BRANCH_STATUSES.has(job.status)
    && writer && typeof writer.status === 'string' && BRANCH_STATUSES.has(writer.status)
    && reviewer && typeof reviewer.status === 'string' && BRANCH_STATUSES.has(reviewer.status)
    && (reviewer.reviewStatus === undefined || typeof reviewer.reviewStatus === 'string' && REVIEW_STATUSES.has(reviewer.reviewStatus)))
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}

function boundedLabel(value: unknown): value is string { return typeof value === 'string' && value.length <= 256 }

const messageStyle: React.CSSProperties = { margin: '8px 0', fontSize: 10, color: 'var(--text-muted)' }
