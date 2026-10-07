'use client'

import React from 'react'
import type { Lang } from '@/lib/i18n'
import type { FeedbackDisposition, FeedbackReason, FeedbackView } from './native-verification-feedback'

const COPY = {
  en: {
    title: 'Result checks', advisory: 'Informational', unavailable: 'Checks unavailable', result: 'Result', check: 'Check',
    status: { passed: 'Passed', failed: 'Failed', uncertain: 'Uncertain' } satisfies Record<FeedbackDisposition, string>,
    reason: {
      meets_criterion: 'Evidence meets this check', does_not_meet_criterion: 'Evidence does not meet this check',
      evidence_missing: 'Evidence is missing', evidence_conflict: 'Evidence conflicts', ambiguous: 'Evidence is ambiguous',
      unsupported_claim: 'Claim is unsupported',
    } satisfies Record<FeedbackReason, string>,
  },
  zh: {
    title: '结果检查', advisory: '仅供参考', unavailable: '检查结果暂不可用', result: '结果', check: '检查项',
    status: { passed: '通过', failed: '未通过', uncertain: '不确定' } satisfies Record<FeedbackDisposition, string>,
    reason: {
      meets_criterion: '证据符合此项要求', does_not_meet_criterion: '证据未满足此项要求',
      evidence_missing: '缺少证据', evidence_conflict: '证据存在冲突', ambiguous: '证据含义不明确',
      unsupported_claim: '主张缺乏支持',
    } satisfies Record<FeedbackReason, string>,
  },
} as const

const cardStyle: React.CSSProperties = { display: 'grid', gap: 7, marginTop: 7, padding: '8px 9px', border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg-secondary)', fontSize: 11 }
const headingStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 8, color: 'var(--text-muted)' }
const listStyle: React.CSSProperties = { display: 'grid', gap: 6, margin: 0, paddingLeft: 22, color: 'var(--text)' }
const rowStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'auto auto 1fr', gap: 7, alignItems: 'baseline' }
const advisoryStyle: React.CSSProperties = { fontSize: 9 }

/** Shows bounded verifier feedback as advisory checks, never as task authority. */
export function NativeVerificationFeedbackCard({ view, lang }: { readonly view: FeedbackView; readonly lang: Lang }) {
  if (view.state === 'none') return null
  const copy = lang === 'zh' ? COPY.zh : COPY.en
  if (view.state === 'unavailable') {
    return <section data-native-verification-feedback="unavailable" role="status" aria-label={copy.title} style={cardStyle}><strong>{copy.title}</strong><span>{copy.unavailable}</span></section>
  }
  return (
    <section data-native-verification-feedback="available" aria-label={copy.title} style={cardStyle}>
      <div style={headingStyle}><strong>{copy.title}</strong><span style={advisoryStyle}>{copy.advisory}</span></div>
      {view.groups.map((group, groupIndex) => <div key={groupIndex} role="group" aria-label={`${copy.result} ${groupIndex + 1}`} style={{ display: 'grid', gap: 4 }}>
        {view.groups.length > 1 && <strong style={advisoryStyle}>{copy.result} {groupIndex + 1}</strong>}
        <ol style={listStyle}>
          {group.checks.map((check, index) => <li key={index} style={rowStyle}>
            <span>{copy.check} {index + 1}</span><strong>{copy.status[check.disposition]}</strong><span>{copy.reason[check.reason]}</span>
          </li>)}
        </ol>
      </div>)}
    </section>
  )
}
