'use client'

import React from 'react'

import { parseObjectiveSlotReviewerReceiptResponse, type ObjectiveSlotReviewerReceipt } from '@/lib/agent/session/objective-slot-reviewer-receipt-contract'
import type { Lang } from '@/lib/i18n'

type ReceiptRequest = Readonly<{ graphRevision: number; slotOrdinal: number }>
type LoadState = Readonly<{ identity: string; state: 'idle' | 'loading' | 'unavailable' }> | Readonly<{
  identity: string; state: 'ready'; receipt: ObjectiveSlotReviewerReceipt
}>

export function buildObjectiveSlotReviewerReceiptUrl(sessionId: string, finalItemId: string, graphRevision: number, slotOrdinal: number): string {
  return `/api/agent/sessions/${encodeURIComponent(sessionId)}/final-items/${encodeURIComponent(finalItemId)}/objective-report/slots/${encodeURIComponent(String(slotOrdinal))}/artifact/reviewer-receipt?graphRevision=${encodeURIComponent(String(graphRevision))}`
}

export function ObjectiveSlotReviewerReceipt({ sessionId, finalItemId, graphRevision, slotOrdinal, ready, ownedLabel, lang }: {
  readonly sessionId: string
  readonly finalItemId: string
  readonly graphRevision: number
  readonly slotOrdinal: number
  readonly ready: boolean
  readonly ownedLabel: string | null
  readonly lang: Lang
}) {
  const identity = JSON.stringify([sessionId, finalItemId, graphRevision, slotOrdinal, ownedLabel, ready])
  const valid = ready && Boolean(ownedLabel) && validScope(sessionId, finalItemId, graphRevision, slotOrdinal)
  const [loadState, setLoadState] = React.useState<LoadState>({ identity, state: 'idle' })
  const controllerRef = React.useRef<AbortController | null>(null)
  const current = loadState.identity === identity ? loadState : { identity, state: 'idle' as const }
  const copy = lang === 'zh' ? zh : en
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
    void loadObjectiveSlotReviewerReceipt({ sessionId, finalItemId, graphRevision, slotOrdinal }, controller.signal).then(receipt => {
      if (controller.signal.aborted) return
      setLoadState(receipt ? { identity, state: 'ready', receipt } : { identity, state: 'unavailable' })
    }).catch(() => {
      if (!controller.signal.aborted) setLoadState({ identity, state: 'unavailable' })
    })
  }

  if (!valid || !ownedLabel) return null
  return <section aria-label={`${copy.heading}: ${ownedLabel}`} data-objective-slot-reviewer-receipt={slotOrdinal} style={sectionStyle}>
    <button type="button" aria-expanded={current.state === 'ready'} aria-controls={disclosureId}
      onClick={load} disabled={current.state === 'loading'} style={buttonStyle}>
      {current.state === 'ready' ? copy.hide : current.state === 'unavailable' ? copy.retry : copy.view}
    </button>
    <div id={disclosureId} aria-busy={current.state === 'loading'}>
      {current.state === 'loading' && <p role="status" aria-live="polite" style={hintStyle}>{copy.loading}</p>}
      {current.state === 'unavailable' && <p role="alert" style={hintStyle}>{copy.unavailable}</p>}
      {current.state === 'ready' && <ReceiptSummary receipt={current.receipt} copy={copy} />}
    </div>
  </section>
}

export async function loadObjectiveSlotReviewerReceipt(request: Readonly<{
  sessionId: string; finalItemId: string; graphRevision: number; slotOrdinal: number
}>, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<ObjectiveSlotReviewerReceipt | null> {
  try {
    const response = await fetcher(buildObjectiveSlotReviewerReceiptUrl(request.sessionId, request.finalItemId, request.graphRevision, request.slotOrdinal), {
      credentials: 'same-origin', cache: 'no-store', signal,
    })
    const body = await response.json().catch(() => null) as unknown
    if (!response.ok) return null
    const parsed = parseObjectiveSlotReviewerReceiptResponse(body, { graphRevision: request.graphRevision, slotOrdinal: request.slotOrdinal } satisfies ReceiptRequest)
    return parsed && !signal.aborted ? parsed : null
  } catch { return null }
}

function ReceiptSummary({ receipt, copy }: { readonly receipt: ObjectiveSlotReviewerReceipt; readonly copy: typeof en }) {
  const value = receipt
  return <dl data-objective-reviewer-receipt="verified" style={summaryStyle}>
    <div><dt>{copy.outcome}</dt><dd>{copy.passed}</dd></div>
    <div><dt>{copy.version}</dt><dd>{value.artifactVersion}</dd></div>
    <div><dt>{copy.receiptKey}</dt><dd><code style={keyStyle}>{value.receiptKey}</code></dd></div>
  </dl>
}

function validScope(sessionId: string, finalItemId: string, graphRevision: number, slotOrdinal: number): boolean {
  return safeId(sessionId) && safeId(finalItemId) && Number.isSafeInteger(graphRevision) && graphRevision > 0
    && Number.isSafeInteger(slotOrdinal) && slotOrdinal > 0 && slotOrdinal <= 8
}
function safeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

const en = { heading: 'Verified Reviewer receipt', view: 'View Reviewer receipt', hide: 'Hide Reviewer receipt', retry: 'Retry Reviewer receipt', loading: 'Loading the verified Reviewer receipt…', unavailable: 'The verified Reviewer receipt is unavailable.', outcome: 'Outcome', passed: 'Passed', version: 'Draft version', receiptKey: 'Receipt reference' }
const zh = { heading: '已验证审核回执', view: '查看本次审核回执', hide: '隐藏本次审核回执', retry: '重试审核回执', loading: '正在加载已验证审核回执…', unavailable: '暂时无法读取已验证审核回执。', outcome: '结果', passed: '通过', version: '草稿版本', receiptKey: '回执引用' }
const sectionStyle: React.CSSProperties = { display: 'grid', gap: 5, marginTop: 5 }
const buttonStyle: React.CSSProperties = { border: 0, padding: 0, background: 'transparent', color: 'var(--primary)', textAlign: 'left', cursor: 'pointer', font: 'inherit' }
const summaryStyle: React.CSSProperties = { display: 'grid', gap: 3, margin: 0, color: 'var(--text-muted)', fontSize: 11 }
const hintStyle: React.CSSProperties = { margin: 0, color: 'var(--text-muted)', fontSize: 11 }
const keyStyle: React.CSSProperties = { overflowWrap: 'anywhere' }
