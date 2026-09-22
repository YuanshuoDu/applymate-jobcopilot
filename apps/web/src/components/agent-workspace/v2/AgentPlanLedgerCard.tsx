'use client'

import React from 'react'

import { useI18n } from '@/lib/i18n'

import type { PlanGraphPhase, PlanGraphStatus, PlanLedgerActionKind, PlanLedgerStepStatus } from './plan-ledger-parser'
import type { PlanLedgerPlan, PlanLedgerProjection } from './plan-ledger-view'

export interface AgentPlanLedgerCardProps {
  readonly ledger: PlanLedgerProjection
}

const ACTION_KEYS: Record<PlanLedgerActionKind, string> = {
  tool_call: 'agent.planLedger.kind.toolCall', delegate: 'agent.planLedger.kind.delegate', join: 'agent.planLedger.kind.join',
  request_input: 'agent.planLedger.kind.requestInput', propose_completion: 'agent.planLedger.kind.proposeCompletion', replan_required: 'agent.planLedger.kind.replanRequired',
}
const STATUS_KEYS: Record<PlanLedgerStepStatus, string> = {
  completed: 'agent.planLedger.status.completed', failed: 'agent.planLedger.status.failed', cancelled: 'agent.planLedger.status.cancelled',
  waiting_for_user: 'agent.planLedger.status.waitingForUser', completion_proposed: 'agent.planLedger.status.completionProposed', replan_required: 'agent.planLedger.status.replanRequired',
}
const GRAPH_STATUS_KEYS: Record<PlanGraphStatus, string> = {
  pending: 'agent.planLedger.graphStatus.pending', ready: 'agent.planLedger.graphStatus.ready', running: 'agent.planLedger.graphStatus.running',
  completed: 'agent.planLedger.status.completed', failed: 'agent.planLedger.status.failed', waiting: 'agent.planLedger.graphStatus.waiting', cancelled: 'agent.planLedger.status.cancelled',
}
const GRAPH_PHASE_KEYS: Record<PlanGraphPhase, string> = {
  start: 'agent.planLedger.graphPhase.start', complete: 'agent.planLedger.graphPhase.complete', fail: 'agent.planLedger.graphPhase.fail',
  wait: 'agent.planLedger.graphPhase.wait', cancel: 'agent.planLedger.graphPhase.cancel', retry: 'agent.planLedger.graphPhase.retry',
}

/** Compact read-only plan projection. It intentionally never renders receipt IDs or result data. */
export function AgentPlanLedgerCard({ ledger }: AgentPlanLedgerCardProps) {
  const { t } = useI18n()
  const plan = ledger.currentPlan
  if (!plan) return null
  return (
    <section data-agent-plan-ledger="true" aria-label={t('agent.planLedger.title')} style={cardStyle}>
      <div style={headingStyle}>
        <strong>{t('agent.planLedger.title')}</strong>
        <span style={mutedStyle}>{t('agent.planLedger.serverOwned')}</span>
      </div>
      <div style={revisionStyle}><span>{t('agent.planLedger.revision')}</span><strong>{plan.planRevision}</strong></div>
      <PlanRows plan={plan} t={t} />
      {Boolean(plan.graphNodes?.length) && <div data-agent-plan-task-graph="true" style={graphStyle}>
        <strong>{t('agent.planLedger.taskGraph')}</strong>
        {plan.graphNodes?.map(node => (
          <div key={node.nodeId} data-agent-plan-task-graph-node="true" style={graphRowStyle}>
            <span>{t('agent.planLedger.kind.planStep')} · <code>{node.nodeId}</code></span>
            <span>{t(GRAPH_STATUS_KEYS[node.status])}</span>
            <span style={mutedStyle}>{node.phase ? `${t(GRAPH_PHASE_KEYS[node.phase])} · ${t('agent.planLedger.attempt')}: ${node.attempt}` : t('agent.planLedger.graphPhase.notStarted')}</span>
            <span style={mutedStyle}>{node.dependencyIds.length ? `${t('agent.planLedger.dependencies')}: ${node.dependencyIds.join(', ')}` : t('agent.planLedger.noDependencies')}</span>
          </div>
        ))}
      </div>}
    </section>
  )
}

function PlanRows({ plan, t }: { plan: PlanLedgerPlan; t: (key: string) => string }) {
  return (
    <div data-agent-plan-ledger-steps="true" style={stepsStyle}>
      {plan.steps.map(step => (
        <div key={step.localId} data-agent-plan-ledger-step="true" style={rowStyle}>
          <span style={localIdStyle}>{step.localId}</span>
          <span>{t(ACTION_KEYS[step.actionKind])}</span>
          <span>{t(STATUS_KEYS[step.status])}</span>
          <span style={mutedStyle}>{step.dependencyCount > 0 ? `${t('agent.planLedger.dependencies')}: ${step.dependencyCount}` : t('agent.planLedger.noDependencies')}</span>
        </div>
      ))}
    </div>
  )
}

const cardStyle: React.CSSProperties = { display: 'grid', gap: 7, marginBottom: 10, padding: 10, border: '1px solid var(--border)', borderRadius: 9, background: 'var(--bg)' }
const headingStyle: React.CSSProperties = { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, fontSize: 12 }
const mutedStyle: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 9 }
const revisionStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: 10 }
const stepsStyle: React.CSSProperties = { display: 'grid', gap: 4, paddingTop: 5, borderTop: '1px solid var(--border)' }
const rowStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 1fr) minmax(0, 1fr)', gap: 5, color: 'var(--text)', fontSize: 9, alignItems: 'baseline' }
const graphStyle: React.CSSProperties = { display: 'grid', gap: 4, paddingTop: 5, borderTop: '1px solid var(--border)', fontSize: 10 }
const graphRowStyle: React.CSSProperties = { display: 'grid', gap: 2, padding: '4px 6px', border: '1px solid var(--border)', borderRadius: 5, overflowWrap: 'anywhere' }
const localIdStyle: React.CSSProperties = { overflowWrap: 'anywhere', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }
