'use client'

import React, { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'

import { useI18n, type Lang } from '@/lib/i18n'

import { parseDraftArtifactPayload, selectedDraftArtifactUrl, validArtifactRef, type DraftArtifactPayload, type DraftArtifactRef, type DraftEvidenceKind, type DraftEvidenceFreshness, type DraftReview } from './draft-artifact-projection'

interface Snapshot { readonly key: string; readonly payload: DraftArtifactPayload | null; readonly loading: boolean; readonly error: boolean }

export function SelectedJobDraftArtifact({ sessionId, artifactRef }: { readonly sessionId: string; readonly artifactRef: DraftArtifactRef | null }) {
  const { data: authSession, status: authStatus } = useSession()
  const { lang } = useI18n()
  const userId = authStatus === 'authenticated' ? authSession?.user?.id ?? null : null
  const ref = artifactRef && validArtifactRef(artifactRef) ? artifactRef : null
  const key = ref ? `${userId ?? 'anonymous'}:${sessionId}:${ref.artifactId}:${ref.version}:${ref.contentHash}:${ref.sourceDigest}` : `${userId ?? 'anonymous'}:${sessionId}:none`
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const visible = snapshot?.key === key ? snapshot : null

  useEffect(() => {
    if (!userId || !ref) {
      setSnapshot({ key, payload: null, loading: false, error: false })
      return
    }
    const controller = new AbortController()
    setSnapshot({ key, payload: null, loading: true, error: false })
    void fetch(selectedDraftArtifactUrl(sessionId, ref), { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        const body = await response.json().catch(() => null) as unknown
        if (!response.ok) throw new Error('draft unavailable')
        const payload = parseDraftArtifactPayload(body, ref)
        if (!payload) throw new Error('draft unavailable')
        return payload
      })
      .then(payload => { if (!controller.signal.aborted) setSnapshot({ key, payload, loading: false, error: false }) })
      .catch(() => { if (!controller.signal.aborted) setSnapshot({ key, payload: null, loading: false, error: true }) })
    return () => controller.abort()
  }, [key, ref, sessionId, userId])

  if (!ref) return null

  const payload = visible?.payload
  const copy = lang === 'zh'
    ? { title: `${payload?.job.role ?? '求职信草稿'} · ${payload?.job.company ?? ''} v${ref.version}`, loading: '正在加载已保存的草稿…', unavailable: '此会话中无法读取该草稿。', evidence: '引用', sourceEvidence: '来源证据', review: '审核', noReview: '尚无审核结果' }
    : { title: `${payload ? `${payload.job.role} · ${payload.job.company}` : 'Cover letter draft'} v${ref.version}`, loading: 'Loading persisted draft…', unavailable: 'This draft is unavailable in this session.', evidence: 'References', sourceEvidence: 'Source evidence', review: 'Review', noReview: 'No review receipt yet' }

  return (
    <article aria-label={copy.title} data-selected-job-draft="true" data-draft-version={ref.version} style={cardStyle}>
      <h3 style={headingStyle}>{copy.title}</h3>
      {visible?.loading && <p role="status" style={hintStyle}>{copy.loading}</p>}
      {visible?.error && <p role="alert" style={hintStyle}>{copy.unavailable}</p>}
      {payload && <>
        <pre data-draft-body="true" style={draftStyle}>{payload.artifact.content.text}</pre>
        <div style={metadataStyle}><strong>{copy.evidence}</strong>{renderRefs([...payload.artifact.provenanceRefs, ...payload.artifact.evidenceRefs, ...(payload.review?.evidenceRefs ?? [])])}</div>
        <SourceEvidence evidence={payload.sourceEvidence} lang={lang} title={copy.sourceEvidence} />
        <div style={metadataStyle}><strong>{copy.review}: {payload.review ? localizedReviewStatus(payload.review.status, lang) : copy.noReview}</strong>
          {payload.review?.findings.map((finding, index) => <div key={`${finding.code}:${index}`} style={findingStyle}><span>{finding.severity} · {finding.code}: </span>{finding.message}{renderRefs(finding.evidenceRefs)}</div>)}
        </div>
      </>}
    </article>
  )
}

function SourceEvidence({ evidence, lang, title }: { readonly evidence: DraftArtifactPayload['sourceEvidence']; readonly lang: Lang; readonly title: string }) {
  const copy = lang === 'zh'
    ? { current: '来源版本与草稿一致。', stale: '来源内容已变化；为避免误导，来源文本已隐藏。', unavailable: '来源证据不可用；来源文本已隐藏。', empty: '未找到可展示的来源摘录。' }
    : { current: 'References match the current source versions.', stale: 'Sources changed after this draft; source text is hidden.', unavailable: 'Source evidence is unavailable; source text is hidden.', empty: 'No source excerpts are available.' }
  const status = evidenceStatus(evidence.freshness, copy)
  return (
    <section data-draft-source-evidence={evidence.freshness} style={metadataStyle}>
      <strong>{title}</strong>
      <p role="status" style={hintStyle}>{status}</p>
      {evidence.freshness === 'current' && (evidence.items.length
        ? evidence.items.map(item => <article key={item.reference} data-source-evidence-item={item.reference} style={sourceEvidenceItemStyle}>
          <strong>{sourceKindLabel(item.kind, lang)} · {item.label}</strong>
          <code>{item.reference}</code>
          <p style={hintStyle}>{item.text}</p>
        </article>)
        : <p style={hintStyle}>{copy.empty}</p>)}
    </section>
  )
}

function evidenceStatus(freshness: DraftEvidenceFreshness, copy: { current: string; stale: string; unavailable: string }): string {
  if (freshness === 'current') return copy.current
  if (freshness === 'stale') return copy.stale
  return copy.unavailable
}

function sourceKindLabel(kind: DraftEvidenceKind, lang: Lang): string {
  if (lang !== 'zh') return { job: 'Job', resume: 'Resume', persona: 'Profile' }[kind]
  return { job: '职位', resume: '简历', persona: '个人资料' }[kind]
}

function renderRefs(refs: readonly string[]) {
  const unique = [...new Set(refs)].slice(0, 32)
  return unique.length ? <ul style={refsStyle}>{unique.map(ref => <li key={ref}><code>{ref}</code></li>)}</ul> : <span style={hintStyle}>—</span>
}

function localizedReviewStatus(status: DraftReview['status'], lang: string): string {
  if (lang !== 'zh') return status
  return {
    passed: '通过',
    needs_revision: '需要修改',
    rejected: '已拒绝',
    stale: '已过期',
  }[status]
}

const cardStyle: React.CSSProperties = { display: 'grid', gap: 7, margin: '10px 0', padding: '10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)' }
const headingStyle: React.CSSProperties = { margin: 0, color: 'var(--text)', fontSize: 12 }
const draftStyle: React.CSSProperties = { maxHeight: 280, overflow: 'auto', margin: 0, padding: 8, borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit', fontSize: 10, lineHeight: 1.5 }
const metadataStyle: React.CSSProperties = { display: 'grid', gap: 3, minWidth: 0, color: 'var(--text-muted)', fontSize: 10, overflowWrap: 'anywhere' }
const refsStyle: React.CSSProperties = { display: 'grid', gap: 2, maxHeight: 80, overflow: 'auto', margin: 0, paddingLeft: 16 }
const hintStyle: React.CSSProperties = { margin: 0, color: 'var(--text-muted)', fontSize: 10, lineHeight: 1.4 }
const findingStyle: React.CSSProperties = { margin: 0, lineHeight: 1.4, overflowWrap: 'anywhere' }
const sourceEvidenceItemStyle: React.CSSProperties = { display: 'grid', gap: 3, minWidth: 0, padding: '6px 0', borderTop: '1px solid var(--border)', overflowWrap: 'anywhere' }
