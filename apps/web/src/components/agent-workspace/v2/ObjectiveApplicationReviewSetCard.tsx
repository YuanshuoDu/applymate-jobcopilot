'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { sha256Hex } from '@jobcopilot/agent-protocol'
import { useApi } from '@/lib/hooks'
import { useI18n } from '@/lib/i18n'
import { SelectedJobDraftArtifact } from './SelectedJobDraftArtifact'
import type { DraftArtifactRef } from './draft-artifact-projection'

type MemberStatus = 'pending' | 'approved' | 'rejected' | 'expired'
type Member = Readonly<{ slotOrdinal: number; approvalId: string; status: MemberStatus; receiptRevision: number;
  job: Readonly<{ company: string; role: string }>; artifactRef: DraftArtifactRef; resumeId: string; decisionAvailable: boolean }>
type Snapshot = Readonly<{ turnId: string; turnRevision: number; setStatus: 'pending' | 'resolved'; members: readonly Member[] }>
type BusyState = Record<string, 'pending' | 'accepted' | 'failed' | undefined>

export function ObjectiveApplicationReviewSetCard({ sessionId, turnId, refreshKey, onAccepted }: {
  readonly sessionId: string; readonly turnId: string; readonly refreshKey: string; readonly onAccepted: () => void
}) {
  const { lang } = useI18n()
  const url = useMemo(() => '/api/agent/sessions/' + encodeURIComponent(sessionId) + '/objective-application-review/' + encodeURIComponent(turnId), [sessionId, turnId])
  const query = useApi<unknown>(url, { enabled: true, cache: false })
  const lastRefresh = useRef({ url, refreshKey })
  const locks = useRef(new Set<string>())
  const [busy, setBusy] = useState<BusyState>({})
  useEffect(() => {
    const previous = lastRefresh.current
    lastRefresh.current = { url, refreshKey }
    if (previous.url === url && previous.refreshKey !== refreshKey) void query.refetch()
  }, [query.refetch, refreshKey, url])

  const envelope = record(query.data)
  const snapshot = !query.error && envelope && exactKeys(envelope, ['snapshot'])
    ? parseObjectiveApplicationReviewSnapshot(envelope.snapshot, turnId) : null
  const copy = lang === 'zh' ? zh : en
  if (!snapshot) return <section aria-label={copy.title} data-objective-review-set="unavailable">
    <strong>{copy.title}</strong><p role="status">{!query.error && query.loading ? copy.loading : copy.unavailable}</p>
  </section>

  const decide = async (member: Member, decision: 'approved' | 'rejected') => {
    const lockKey = JSON.stringify([sessionId, turnId, snapshot.turnRevision, member.approvalId, member.receiptRevision])
    const requestKey = JSON.stringify([sessionId, turnId, snapshot.turnRevision, member.approvalId, member.receiptRevision, decision])
    if (locks.current.has(lockKey) || busy[member.approvalId] === 'pending' || busy[member.approvalId] === 'accepted') return
    locks.current.add(lockKey)
    setBusy(current => ({ ...current, [member.approvalId]: 'pending' }))
    try {
      const idempotencyKey = 'objective-review-decision-' + await sha256Hex(requestKey)
      const response = await fetch(url, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approvalId: member.approvalId,
          expectedRevision: snapshot.turnRevision, expectedReceiptRevision: member.receiptRevision, idempotencyKey, decision }) })
      const result = await response.json().catch(() => null) as unknown
      if (!response.ok || !validDecisionResult(result)) throw new Error('decision unavailable')
      setBusy(current => ({ ...current, [member.approvalId]: 'accepted' }))
      await query.refetch()
      onAccepted()
    } catch {
      setBusy(current => ({ ...current, [member.approvalId]: 'failed' }))
    } finally { locks.current.delete(lockKey) }
  }

  return <section aria-label={copy.title} data-objective-review-set={snapshot.setStatus} style={sectionStyle}>
    <h3 style={headingStyle}>{copy.title}</h3>
    <p style={hintStyle}>{copy.disclaimer}</p>
    {snapshot.members.map(member => {
      const pending = member.status === 'pending', state = busy[member.approvalId]
      const disabled = query.loading || state === 'pending' || state === 'accepted'
      return <article key={member.slotOrdinal} data-objective-review-member={member.status} style={memberStyle}>
        <strong>{copy.job} {member.slotOrdinal}: {member.job.role} · {member.job.company}</strong>
        <ReviewedDraftDisclosure sessionId={sessionId} artifactRef={member.artifactRef} label={copy.materials} />
        <a href={'/resume/' + encodeURIComponent(member.resumeId) + '/print'} target='_blank' rel='noreferrer'>{copy.resume}</a>
        <p role={pending && !member.decisionAvailable ? 'status' : undefined} style={hintStyle}>
          {pending && !member.decisionAvailable ? copy.stale : copy.status[member.status]}
        </p>
        {pending && <div style={actionsStyle}>
          {member.decisionAvailable && <button type='button' disabled={disabled} onClick={() => void decide(member, 'approved')}>{state === 'pending' ? copy.saving : copy.approve}</button>}
          <button type='button' disabled={disabled} onClick={() => void decide(member, 'rejected')}>{state === 'pending' ? copy.saving : copy.decline}</button>
        </div>}
        {state === 'failed' && <p role='alert' style={hintStyle}>{copy.failed}</p>}
      </article>
    })}
  </section>
}

export function parseObjectiveApplicationReviewSnapshot(value: unknown, expectedTurnId: string): Snapshot | null {
  const row = record(value)
  if (!row || !exactKeys(row, ['turnId', 'turnRevision', 'setStatus', 'members']) || row.turnId !== expectedTurnId
    || !safeRevision(row.turnRevision) || (row.setStatus !== 'pending' && row.setStatus !== 'resolved')
    || !Array.isArray(row.members) || Object.getPrototypeOf(row.members) !== Array.prototype
    || Reflect.ownKeys(row.members).length !== row.members.length + 1 || row.members.length < 1 || row.members.length > 8) return null
  const members: Member[] = [], approvalIds = new Set<string>()
  let previous = 0
  for (let index = 0; index < row.members.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(row.members, String(index))
    const member = descriptor && 'value' in descriptor ? record(descriptor.value) : null
    const job = record(member?.job), artifact = record(member?.artifactRef)
    if (!member || !exactKeys(member, ['slotOrdinal', 'approvalId', 'status', 'receiptRevision', 'job', 'artifactRef', 'resumeId', 'decisionAvailable'])
      || !safeRevision(member.slotOrdinal) || Number(member.slotOrdinal) < 1 || Number(member.slotOrdinal) > 8 || Number(member.slotOrdinal) <= previous
      || !safeId(member.approvalId) || approvalIds.has(member.approvalId) || !status(member.status) || !safeRevision(member.receiptRevision)
      || typeof member.decisionAvailable !== 'boolean' || member.decisionAvailable && member.status !== 'pending'
      || !job || !exactKeys(job, ['company', 'role']) || !boundedText(job.company, 160) || !boundedText(job.role, 160)
      || !artifact || !exactKeys(artifact, ['artifactId', 'version', 'contentHash', 'sourceDigest']) || !safeId(artifact.artifactId)
      || !safeRevision(artifact.version) || Number(artifact.version) < 1 || !digest(artifact.contentHash) || !digest(artifact.sourceDigest)
      || !safeId(member.resumeId)) return null
    previous = Number(member.slotOrdinal); approvalIds.add(member.approvalId)
    members.push({ slotOrdinal: previous, approvalId: member.approvalId, status: member.status as MemberStatus,
      receiptRevision: Number(member.receiptRevision), job: { company: job.company, role: job.role },
      artifactRef: { artifactId: artifact.artifactId, version: Number(artifact.version), contentHash: artifact.contentHash, sourceDigest: artifact.sourceDigest },
      resumeId: member.resumeId, decisionAvailable: member.decisionAvailable })
  }
  if (row.setStatus === 'resolved' && members.some(member => member.status === 'pending')
    || row.setStatus === 'pending' && !members.some(member => member.status === 'pending')) return null
  return { turnId: row.turnId as string, turnRevision: Number(row.turnRevision), setStatus: row.setStatus, members }
}

function validDecisionResult(value: unknown): boolean {
  const row = record(value)
  return Boolean(row && exactKeys(row, ['disposition', 'status', 'setCompleted', 'turnRevision'])
    && (row.disposition === 'resolved' || row.disposition === 'duplicate')
    && (row.status === 'approved' || row.status === 'rejected' || row.status === 'expired')
    && typeof row.setCompleted === 'boolean' && safeRevision(row.turnRevision))
}
function ReviewedDraftDisclosure({ sessionId, artifactRef, label }: { sessionId: string; artifactRef: DraftArtifactRef; label: string }) {
  const [open, setOpen] = useState(false)
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{label}</summary>{open && <SelectedJobDraftArtifact sessionId={sessionId} artifactRef={artifactRef} />}
  </details>
}
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try { const proto = Object.getPrototypeOf(value); return proto === Object.prototype || proto === null ? value as Record<string, unknown> : null } catch { return null }
}
function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  try { const own = Reflect.ownKeys(row); return own.length === keys.length && own.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(row, key)
    return typeof key === 'string' && keys.includes(key) && descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value')
  }) } catch { return false }
}
function status(value: unknown): value is MemberStatus { return value === 'pending' || value === 'approved' || value === 'rejected' || value === 'expired' }
function safeId(value: unknown): value is string { return typeof value === 'string' && value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value) }
function safeRevision(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function boundedText(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value }
function digest(value: unknown): value is string { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value) }

const en = { title: 'Application review decisions', loading: 'Loading the current review set…', unavailable: 'Review details are unavailable.',
  disclaimer: 'Approval allows a later form fill. Submitting an application requires separate approval.', job: 'Job', resume: 'View resume',
  approve: 'Approve for form fill', decline: 'Decline', saving: 'Saving…', failed: 'The decision could not be saved. Refresh and try again.',
  stale: 'This material may have changed. Close this request to start a fresh review.',
  materials: 'View reviewed draft',
  status: { pending: 'Awaiting your decision', approved: 'Approved for form fill', rejected: 'Declined', expired: 'No longer current' } }
const zh = { title: '申请材料审核决定', loading: '正在读取当前审核…', unavailable: '暂时无法读取审核详情。',
  disclaimer: '批准后可用于后续表单填写。提交申请仍需单独批准。', job: '职位', resume: '查看简历',
  approve: '批准用于表单填写', decline: '拒绝', saving: '正在保存…', failed: '无法保存决定，请刷新后重试。',
  stale: '材料可能已变化。关闭这条请求后可重新审核。',
  materials: '查看已审核的草稿',
  status: { pending: '等待你的决定', approved: '已批准用于表单填写', rejected: '已拒绝', expired: '材料已不再有效' } }
const sectionStyle: React.CSSProperties = { display: 'grid', gap: 8, marginTop: 8, padding: 10, border: '1px solid var(--border)', borderRadius: 8 }
const headingStyle: React.CSSProperties = { margin: 0, fontSize: 12, color: 'var(--text)' }
const hintStyle: React.CSSProperties = { margin: 0, color: 'var(--text-muted)', fontSize: 10, lineHeight: 1.4 }
const memberStyle: React.CSSProperties = { display: 'grid', gap: 6, padding: 8, borderTop: '1px solid var(--border)', fontSize: 11 }
const actionsStyle: React.CSSProperties = { display: 'flex', gap: 6 }
