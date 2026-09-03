'use client'

import React from 'react'
import { artifactViewState, budgetViewState } from './agent-workspace-projection'
import type { AgentWorkspaceArtifact, AgentWorkspaceBudget, AgentWorkspaceCompaction, AgentWorkspaceUncertainty } from './session-view-model'

export function SessionStatusCards({ artifacts = [], budget, compaction, uncertain = [], currentTurnId }: {
  artifacts?: AgentWorkspaceArtifact[]
  budget?: AgentWorkspaceBudget
  compaction?: AgentWorkspaceCompaction
  uncertain?: AgentWorkspaceUncertainty[]
  currentTurnId?: string | null
}) {
  const hasOperationalState = Boolean(budget || compaction || uncertain.length)
  return (
    <>
      {artifacts.length > 0 && (
        <StatusSection title="Artifacts">
          {artifacts.map(artifact => <ArtifactCard key={artifact.id} artifact={artifact} currentTurnId={currentTurnId} />)}
        </StatusSection>
      )}
      {hasOperationalState && (
        <StatusSection title="Cost and confidence">
          {budget && <BudgetCard budget={budget} />}
          {compaction && <CompactionCard compaction={compaction} />}
          {uncertain.length > 0 && <UncertaintyCard items={uncertain} />}
        </StatusSection>
      )}
    </>
  )
}

function ArtifactCard({ artifact, currentTurnId }: { artifact: AgentWorkspaceArtifact; currentTurnId?: string | null }) {
  const state = artifactViewState({ ...artifact, currentTurnId })
  const stateText = state === 'current' ? 'Current' : state === 'stale' ? 'Stale — review required' : 'Uncertain — version/hash incomplete'
  const stateColor = state === 'current' ? 'var(--c-success)' : '#d97706'
  return (
    <div style={cardStyle} data-artifact-state={state}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <strong style={titleStyle}>{artifact.title}</strong>
        <span style={{ ...badgeStyle, color: stateColor }}>{stateText}</span>
      </div>
      <div style={metaStyle}>{artifact.type} · version {artifact.version ?? 'unknown'}{artifact.turnId ? ` · Turn ${artifact.turnId}` : ''}</div>
      <div style={hashStyle}>hash: {artifact.hash ?? 'not available'}</div>
      {state === 'stale' && <div style={{ ...metaStyle, color: '#d97706' }}>{artifact.staleReason ?? (currentTurnId ? 'Artifact belongs to an older Turn.' : 'Artifact was invalidated by a newer version.')}</div>}
    </div>
  )
}

function BudgetCard({ budget }: { budget: AgentWorkspaceBudget }) {
  const state = budgetViewState(budget.used, budget.limit)
  const stateText = state === 'ok' ? 'Within budget' : state === 'near_limit' ? 'Near limit' : state === 'exhausted' ? 'Budget exhausted' : 'Budget not reported'
  const value = budget.used == null || budget.limit == null ? '—' : `${budget.used} / ${budget.limit}${budget.unit ? ` ${budget.unit}` : ''}`
  return <div style={cardStyle} data-budget-state={state}><div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong style={titleStyle}>Budget</strong><span style={{ ...badgeStyle, color: state === 'ok' ? 'var(--c-success)' : '#d97706' }}>{stateText}</span></div><div style={valueStyle}>{value}</div>{budget.warning && <div style={{ ...metaStyle, color: '#d97706' }}>{budget.warning}</div>}</div>
}

function CompactionCard({ compaction }: { compaction: AgentWorkspaceCompaction }) {
  const before = compaction.beforeTokens == null ? '—' : String(compaction.beforeTokens)
  const after = compaction.afterTokens == null ? '—' : String(compaction.afterTokens)
  return <div style={cardStyle} data-compaction-state={compaction.status}><div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong style={titleStyle}>Compaction</strong><span style={{ ...badgeStyle, color: compaction.status === 'failed' ? 'var(--c-danger)' : compaction.status === 'running' ? '#d97706' : 'var(--c-success)' }}>{compaction.status}</span></div><div style={metaStyle}>tokens {before} → {after}{compaction.lastCompactedAt ? ` · ${compaction.lastCompactedAt}` : ''}</div>{compaction.message && <div style={{ ...metaStyle, whiteSpace: 'normal' }}>{compaction.message}</div>}</div>
}

function UncertaintyCard({ items }: { items: AgentWorkspaceUncertainty[] }) {
  return <div style={cardStyle} data-uncertain-count={items.length}><strong style={{ ...titleStyle, color: '#d97706' }}>Uncertain state</strong>{items.map(item => <div key={item.id} style={{ marginTop: 5, fontSize: 10, color: 'var(--text)' }}><b>{item.label}</b> · {item.detail}{item.severity ? ` (${item.severity})` : ''}</div>)}</div>
}

function StatusSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section style={{ padding: '0 10px 12px' }}><div style={sectionTitleStyle}>{title}</div><div style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)', padding: 8 }}>{children}</div></section>
}

const cardStyle: React.CSSProperties = { padding: '7px 1px', borderTop: '1px solid var(--border)' }
const titleStyle: React.CSSProperties = { fontSize: 10, color: 'var(--text)' }
const badgeStyle: React.CSSProperties = { marginLeft: 'auto', flexShrink: 0, fontSize: 9, fontWeight: 700 }
const valueStyle: React.CSSProperties = { marginTop: 4, fontSize: 12, fontWeight: 750, color: 'var(--text)' }
const metaStyle: React.CSSProperties = { marginTop: 3, fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.4 }
const hashStyle: React.CSSProperties = { ...metaStyle, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const sectionTitleStyle: React.CSSProperties = { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 700, marginBottom: 6 }
