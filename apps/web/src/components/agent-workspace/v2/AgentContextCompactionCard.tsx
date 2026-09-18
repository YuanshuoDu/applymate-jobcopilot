'use client'

import React from 'react'

import { useI18n } from '@/lib/i18n'

import type { TimelineContextCompactionProjection, TimelineContextCompactionProjectionRecord, TimelineContextCompactionStatus } from './timeline-context-compaction'

export interface AgentContextCompactionCardProps {
  readonly ledger: TimelineContextCompactionProjection
}

const STATUS_KEYS: Record<TimelineContextCompactionStatus, string> = {
  unchanged: 'agent.contextCompaction.status.unchanged',
  compacted: 'agent.contextCompaction.status.compacted',
  failed: 'agent.contextCompaction.status.failed',
}

/** Read-only bounded context-compaction metrics; raw snapshot and identity fields never reach the DOM. */
export function AgentContextCompactionCard({ ledger }: AgentContextCompactionCardProps) {
  const { t } = useI18n()
  return (
    <section data-agent-context-compaction="true" aria-label={t('agent.contextCompaction.title')} style={cardStyle}>
      <div style={headingStyle}><strong>{t('agent.contextCompaction.title')}</strong><span style={mutedStyle}>{t('agent.contextCompaction.serverOwned')}</span></div>
      {ledger.records.length === 0
        ? <p data-agent-context-compaction-empty="true" style={emptyStyle}>{t('agent.contextCompaction.empty')}</p>
        : <div data-agent-context-compaction-records="true" style={recordsStyle}>{ledger.records.map(record => <CompactionRecord key={`${record.scopeOrdinal}:${record.sequence}`} record={record} scopeLabel={`${t('agent.contextCompaction.scope')} ${record.scopeOrdinal}`} t={t} />)}</div>}
    </section>
  )
}

function CompactionRecord({ record, scopeLabel, t }: { record: TimelineContextCompactionProjectionRecord; scopeLabel: string; t: (key: string) => string }) {
  return (
    <div data-agent-context-compaction-record="true" style={recordStyle}>
      <div style={scopeStyle}><span>{scopeLabel}</span><span>{t(STATUS_KEYS[record.status])}</span></div>
      <div style={metricsStyle}>
        <span>{t('agent.contextCompaction.beforeTokens')}: {formatNumber(record.beforeInputTokens)}</span>
        <span>{t('agent.contextCompaction.afterTokens')}: {formatNumber(record.afterInputTokens)}</span>
        <span>{t('agent.contextCompaction.savedTokens')}: {formatNumber(record.savedTokens)}</span>
        <span>{t('agent.contextCompaction.reduction')}: {Math.round(record.tokenReductionRatio * 100)}%</span>
      </div>
    </div>
  )
}

function formatNumber(value: number): string { return new Intl.NumberFormat().format(value) }

const cardStyle: React.CSSProperties = { display: 'grid', gap: 7, marginBottom: 10, padding: 10, border: '1px solid var(--border)', borderRadius: 9, background: 'var(--bg)' }
const headingStyle: React.CSSProperties = { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, fontSize: 12 }
const mutedStyle: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 9 }
const emptyStyle: React.CSSProperties = { margin: 0, color: 'var(--text-muted)', fontSize: 10 }
const recordsStyle: React.CSSProperties = { display: 'grid', gap: 5, paddingTop: 5, borderTop: '1px solid var(--border)' }
const recordStyle: React.CSSProperties = { display: 'grid', gap: 3, color: 'var(--text)', fontSize: 9 }
const scopeStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 8, overflowWrap: 'anywhere' }
const metricsStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3, color: 'var(--text-muted)' }
