'use client'

import React from 'react'

import type { TaskGraphVerificationDisplayCheck, TaskGraphVerificationDisplayNode } from '@jobcopilot/agent-protocol'
import type { Lang } from '@/lib/i18n'
import { taskGraphPlanLabel, type TaskGraphPlanLabelKey } from '@/lib/task-graph-plan-labels'

export function TaskGraphVerificationSummary({ node, lang }: {
  readonly node: TaskGraphVerificationDisplayNode | undefined
  readonly lang: Lang
}) {
  if (!node) return null
  const label = (key: TaskGraphPlanLabelKey) => taskGraphPlanLabel(lang, key)
  if (node.status === 'unavailable') return <div data-task-graph-verification="unavailable" style={boxStyle}>
    <strong>{label('agent.taskGraph.verification.title')}</strong>
    <span>{label('agent.taskGraph.verification.unavailable')}</span>
  </div>

  const status = node.status === 'passed' ? 'agent.taskGraph.verification.passed'
    : node.status === 'failed' ? 'agent.taskGraph.verification.failed' : 'agent.taskGraph.verification.unverified'
  return <section aria-label={label('agent.taskGraph.verification.title')} data-task-graph-verification={node.status} style={boxStyle}>
    <strong>{label('agent.taskGraph.verification.title')}: {label(status)}</strong>
    <span>{label('agent.taskGraph.verification.total')}: {node.totalCount} · {node.passedCount} {label('agent.taskGraph.verification.passedCount')} · {node.failedCount} {label('agent.taskGraph.verification.failedCount')} · {node.unverifiedCount} {label('agent.taskGraph.verification.unverifiedCount')}</span>
    <ul style={listStyle}>{node.checks.map((check, index) => <li key={index}>
      <span>{label(`agent.taskGraph.verification.${check.kind}` as TaskGraphPlanLabelKey)}{checkDetail(check, label)}</span>
      <span>{label(check.status === 'passed' ? 'agent.taskGraph.verification.passed'
        : check.status === 'failed' ? 'agent.taskGraph.verification.failed' : 'agent.taskGraph.verification.unverified')}</span>
    </li>)}</ul>
  </section>
}

function checkDetail(check: TaskGraphVerificationDisplayCheck, label: (key: TaskGraphPlanLabelKey) => string): string {
  if (check.kind === 'candidate_count_gte' || check.kind === 'finding_count_gte' || check.kind === 'evidence_count_gte') return `: ${check.minimum}`
  if (check.kind === 'all_candidates_have_evidence' || check.kind === 'all_findings_have_evidence')
    return ` (${label('agent.taskGraph.verification.minimumItems')}: ${check.minimumItems})`
  if (check.kind === 'reported_score_gte') return `: ${check.minimumScore} / 10 (${label('agent.taskGraph.verification.minimumFindings')}: ${check.minimumFindings}, ${label(`agent.taskGraph.verification.aggregation.${check.aggregation}` as TaskGraphPlanLabelKey)})`
  return ''
}

const boxStyle: React.CSSProperties = { display: 'grid', gap: 3, borderLeft: '2px solid var(--border)', paddingLeft: 6, overflowWrap: 'anywhere' }
const listStyle: React.CSSProperties = { display: 'grid', gap: 2, margin: 0, paddingLeft: 16 }
