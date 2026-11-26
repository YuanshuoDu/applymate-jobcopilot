'use client'

import React from 'react'

import { parseObjectiveSourceToolReceiptEvidence } from '@/lib/agent/session/objective-source-tool-receipts-contract'
import type { Lang } from '@/lib/i18n'

export type ObjectiveSourceToolReceiptRole = 'scout' | 'analyst'
export type ObjectiveSourceToolReceiptRequest = Readonly<{
  sessionId: string
  finalItemId: string
  sourceKey: string
  graphRevision: number
  role: ObjectiveSourceToolReceiptRole
  lang: Lang
}>
type Evidence = NonNullable<ReturnType<typeof parseObjectiveSourceToolReceiptEvidence>>
type LoadState = Readonly<{ identity: string; state: 'idle' | 'loading' | 'unavailable' }> | Readonly<{
  identity: string; state: 'ready'; evidence: Evidence
}>

export function ObjectiveSourceToolReceipts(request: ObjectiveSourceToolReceiptRequest) {
  const identity = requestIdentity(request)
  const valid = safeId(request.sessionId) && safeId(request.finalItemId) && safeSourceKey(request.sourceKey)
    && Number.isSafeInteger(request.graphRevision) && request.graphRevision > 0
    && (request.role === 'scout' || request.role === 'analyst')
  const [loadState, setLoadState] = React.useState<LoadState>({ identity, state: 'idle' })
  const controllerRef = React.useRef<AbortController | null>(null)
  const copy = request.lang === 'zh' ? zh : en
  const current = loadState.identity === identity ? loadState : { identity, state: 'idle' as const }
  const disclosureId = React.useId()

  React.useEffect(() => {
    controllerRef.current?.abort()
    setLoadState({ identity, state: 'idle' })
    return () => controllerRef.current?.abort()
  }, [identity])

  const load = () => {
    if (!valid || current.state === 'loading') return
    if (current.state === 'ready') {
      setLoadState({ identity, state: 'idle' })
      return
    }
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setLoadState({ identity, state: 'loading' })
    void loadObjectiveSourceToolReceipts(request, controller.signal).then(evidence => {
      if (controller.signal.aborted) return
      setLoadState(evidence ? { identity, state: 'ready', evidence } : { identity, state: 'unavailable' })
    })
  }

  if (!valid) return null
  return <section aria-label={copy.heading} data-objective-tool-receipts="true" style={sectionStyle}>
    <button type="button" aria-expanded={current.state === 'ready'} aria-controls={`objective-tool-receipts-${disclosureId}`}
      onClick={load} disabled={current.state === 'loading'} style={buttonStyle}>
      {current.state === 'ready' ? copy.hide : current.state === 'unavailable' ? copy.retry : copy.view}
    </button>
    <div id={`objective-tool-receipts-${disclosureId}`} aria-busy={current.state === 'loading'}>
      {current.state === 'loading' && <p role="status" aria-live="polite">{copy.loading}</p>}
      {current.state === 'unavailable' && <p role="alert">{copy.unavailable}</p>}
      {current.state === 'ready' && <ReceiptList evidence={current.evidence} copy={copy} />}
    </div>
  </section>
}

export async function loadObjectiveSourceToolReceipts(request: ObjectiveSourceToolReceiptRequest, signal: AbortSignal,
  fetcher: typeof fetch = fetch): Promise<Evidence | null> {
  try {
    const response = await fetcher(objectiveSourceToolReceiptsUrl(request.sessionId, request.finalItemId, request.sourceKey, request.graphRevision), {
      credentials: 'same-origin', cache: 'no-store', signal,
    })
    if (!response.ok) throw new Error('unavailable')
    const body = await response.json()
    if (signal.aborted) return null
    return parseObjectiveSourceToolReceiptResponse(body, request)
  } catch { return null }
}

export function parseObjectiveSourceToolReceiptResponse(value: unknown, request: ObjectiveSourceToolReceiptRequest): Evidence | null {
  const root = record(value)
  if (!root || !exactKeys(root, ['toolReceiptEvidence'])) return null
  const evidence = parseObjectiveSourceToolReceiptEvidence(root.toolReceiptEvidence)
  return evidence && evidence.graphRevision === request.graphRevision && evidence.sourceKey === request.sourceKey
    && evidence.role === request.role ? evidence : null
}

export function objectiveSourceToolReceiptsUrl(sessionId: string, finalItemId: string, sourceKey: string, graphRevision: number): string {
  return `/api/agent/sessions/${encodeURIComponent(sessionId)}/final-items/${encodeURIComponent(finalItemId)}/task-graph-sources/${encodeURIComponent(sourceKey)}/tool-receipts?graphRevision=${encodeURIComponent(String(graphRevision))}`
}

function ReceiptList({ evidence, copy }: { readonly evidence: Evidence; readonly copy: Copy }) {
  return <ul style={listStyle}>{evidence.receipts.map(receipt => <li key={receipt.receiptKey} style={receiptStyle}>
    <strong>{toolLabel(receipt.toolName, copy)}</strong> · {copy.receipt} {receipt.ordinal} · {deliveryLabel(receipt.delivery, copy)}
  </li>)}</ul>
}

function toolLabel(toolName: string, copy: Copy): string {
  return copy.tools[toolName as keyof typeof copy.tools] ?? copy.unknownTool
}
function deliveryLabel(delivery: string, copy: Copy): string { return delivery === 'replayed' ? copy.replayed : copy.fresh }
function requestIdentity(request: ObjectiveSourceToolReceiptRequest): string {
  return JSON.stringify([request.sessionId, request.finalItemId, request.sourceKey, request.graphRevision, request.role])
}
function safeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value)
}
function safeSourceKey(value: unknown): value is string { return typeof value === 'string' && /^src_[A-Za-z0-9_-]{43}$/.test(value) }
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try { return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null ? value as Record<string, unknown> : null } catch { return null }
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  try { const keys = Reflect.ownKeys(value); return keys.length === expected.length && keys.every(key => typeof key === 'string' && expected.includes(key)) }
  catch { return false }
}

type Copy = typeof en
const en = { heading: 'Verified tool receipts', view: 'View tool receipts', hide: 'Hide tool receipts', retry: 'Retry tool receipts',
  loading: 'Loading verified tool receipts…', unavailable: 'Tool receipt evidence is unavailable.', receipt: 'Receipt', fresh: 'Fresh delivery', replayed: 'Replayed delivery', unknownTool: 'Verified tool',
  tools: { 'jobs.discover': 'Job discovery', 'jobs.search': 'Job search', 'jobs.get': 'Job details', 'tool_results.read': 'Durable result read' } }
const zh = { heading: '已验证工具回执', view: '查看工具回执', hide: '隐藏工具回执', retry: '重试工具回执',
  loading: '正在加载已验证工具回执…', unavailable: '工具回执证据不可用。', receipt: '回执', fresh: '首次投递', replayed: '重放投递', unknownTool: '已验证工具',
  tools: { 'jobs.discover': '职位发现', 'jobs.search': '职位搜索', 'jobs.get': '职位详情', 'tool_results.read': '持久结果读取' } }
const sectionStyle: React.CSSProperties = { display: 'grid', gap: 5, marginTop: 5 }
const buttonStyle: React.CSSProperties = { border: 0, padding: 0, background: 'transparent', color: 'var(--primary)', textAlign: 'left', cursor: 'pointer', font: 'inherit' }
const listStyle: React.CSSProperties = { display: 'grid', gap: 4, margin: 0, paddingLeft: 18 }
const receiptStyle: React.CSSProperties = { color: 'var(--text)', overflowWrap: 'anywhere' }
