'use client'

import React, { useEffect, useState } from 'react'

import type { Lang } from '@/lib/i18n'

import { SelectedJobDraftArtifact } from './SelectedJobDraftArtifact'
import { ObjectiveSlotReviewerReceipt } from './ObjectiveSlotReviewerReceipt'
import { validArtifactRef, type DraftArtifactRef } from './draft-artifact-projection'

export const OBJECTIVE_SLOT_ARTIFACT_SCHEMA = 'agent-harness.v2.objective-slot-artifact.v1' as const

type ExpectedArtifact = Readonly<{ graphRevision: number; slotOrdinal: number }>
type RequestState = Readonly<{
  key: string
  status: 'idle' | 'loading' | 'ready' | 'unavailable'
  artifactRef?: DraftArtifactRef
}>

export function buildObjectiveSlotArtifactUrl(sessionId: string, finalItemId: string, graphRevision: number, slotOrdinal: number): string {
  return `/api/agent/sessions/${encodeURIComponent(sessionId)}/final-items/${encodeURIComponent(finalItemId)}/objective-report/slots/${encodeURIComponent(String(slotOrdinal))}/artifact?graphRevision=${encodeURIComponent(String(graphRevision))}`
}

/** Parses only the dedicated envelope; the normal report never carries this reference. */
export function parseObjectiveSlotArtifactResponse(value: unknown, expected: ExpectedArtifact): DraftArtifactRef | null {
  const root = closedRecord(value, ['artifactEvidence'])
  const evidence = root && closedRecord(root.artifactEvidence, ['artifactRef', 'graphRevision', 'schemaVersion', 'slotOrdinal'])
  const ref = evidence && closedRecord(evidence.artifactRef, ['artifactId', 'contentHash', 'sourceDigest', 'version'])
  if (!evidence || !ref || evidence.schemaVersion !== OBJECTIVE_SLOT_ARTIFACT_SCHEMA
    || evidence.graphRevision !== expected.graphRevision || evidence.slotOrdinal !== expected.slotOrdinal
    || !validArtifactRef(ref)) return null
  return { artifactId: ref.artifactId, version: ref.version, contentHash: ref.contentHash, sourceDigest: ref.sourceDigest }
}

export function ObjectiveSlotArtifact({ sessionId, finalItemId, graphRevision, slotOrdinal, ready, ownedLabel, lang }: {
  readonly sessionId: string
  readonly finalItemId: string
  readonly graphRevision: number
  readonly slotOrdinal: number
  readonly ready: boolean
  readonly ownedLabel: string | null
  readonly lang: Lang
}) {
  const eligible = ready && Boolean(ownedLabel) && validScope(sessionId, finalItemId, graphRevision, slotOrdinal)
  const key = JSON.stringify([sessionId, finalItemId, graphRevision, slotOrdinal, ownedLabel, ready])
  const url = eligible ? buildObjectiveSlotArtifactUrl(sessionId, finalItemId, graphRevision, slotOrdinal) : ''
  const [openForKey, setOpenForKey] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [state, setState] = useState<RequestState>({ key, status: 'idle' })
  const copy = lang === 'zh' ? zh : en
  const open = openForKey === key

  useEffect(() => {
    if (openForKey !== null && openForKey !== key) setOpenForKey(null)
  }, [key, openForKey])

  useEffect(() => {
    if (!eligible || !open) {
      setState({ key, status: 'idle' })
      return
    }
    const controller = new AbortController()
    setState({ key, status: 'loading' })
    void fetch(url, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        const body = await response.json().catch(() => null) as unknown
        if (!response.ok) throw new Error('objective slot artifact unavailable')
        const artifactRef = parseObjectiveSlotArtifactResponse(body, { graphRevision, slotOrdinal })
        if (!artifactRef) throw new Error('objective slot artifact unavailable')
        return artifactRef
      })
      .then(artifactRef => {
        if (!controller.signal.aborted) setState({ key, status: 'ready', artifactRef })
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ key, status: 'unavailable' })
      })
    return () => controller.abort()
  }, [eligible, graphRevision, key, open, retry, slotOrdinal, url])

  if (!eligible || !ownedLabel) return null
  const visible = state.key === key ? state : { key, status: 'idle' as const }
  return <section data-objective-slot-artifact={slotOrdinal} aria-label={`${copy.title}: ${ownedLabel}`} style={sectionStyle}>
    {!open && <button type="button" onClick={() => setOpenForKey(key)} style={buttonStyle}>
      {copy.open}
    </button>}
    {open && visible.status === 'loading' && <p role="status" style={hintStyle}>{copy.loading}</p>}
    {open && visible.status === 'unavailable' && <div style={actionStyle}>
      <p role="alert" style={hintStyle}>{copy.unavailable}</p>
      <button type="button" onClick={() => setRetry(value => value + 1)} style={buttonStyle}>{copy.retry}</button>
    </div>}
    {open && visible.status === 'ready' && visible.artifactRef && <>
      <SelectedJobDraftArtifact sessionId={sessionId} artifactRef={visible.artifactRef} />
      <button type="button" onClick={() => setOpenForKey(null)} style={buttonStyle}>{copy.close}</button>
    </>}
    <ObjectiveSlotReviewerReceipt sessionId={sessionId} finalItemId={finalItemId} graphRevision={graphRevision}
      slotOrdinal={slotOrdinal} ready={ready} ownedLabel={ownedLabel} lang={lang} />
  </section>
}

function validScope(sessionId: string, finalItemId: string, graphRevision: number, slotOrdinal: number): boolean {
  return safeId(sessionId) && safeId(finalItemId) && Number.isSafeInteger(graphRevision) && graphRevision > 0
    && Number.isSafeInteger(slotOrdinal) && slotOrdinal > 0
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function closedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const row = value as Record<string, unknown>
    const ownKeys = Reflect.ownKeys(row)
    if (Object.getPrototypeOf(row) !== Object.prototype && Object.getPrototypeOf(row) !== null
      || ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return null
    if (keys.some(key => !Object.getOwnPropertyDescriptor(row, key)?.enumerable
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(row, key)!, 'value'))) return null
    return row
  } catch { return null }
}

const en = { title: 'Verified draft', open: 'View verified draft', loading: 'Loading the verified draft…', unavailable: 'The verified draft is unavailable.', retry: 'Retry', close: 'Hide draft' }
const zh = { title: '已验证草稿', open: '查看已验证草稿', loading: '正在加载已验证草稿…', unavailable: '暂时无法读取已验证草稿。', retry: '重试', close: '隐藏草稿' }
const sectionStyle: React.CSSProperties = { display: 'grid', gap: 6, marginTop: 6 }
const actionStyle: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }
const buttonStyle: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 7, padding: '6px 9px', background: 'var(--bg-secondary)', color: 'var(--primary)', cursor: 'pointer', font: 'inherit', fontSize: 11, fontWeight: 600 }
const hintStyle: React.CSSProperties = { margin: 0, color: 'var(--text-muted)', fontSize: 11 }
