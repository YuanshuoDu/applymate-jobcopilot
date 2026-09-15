'use client'

import React from 'react'

import { useI18n } from '@/lib/i18n'

import type { PlanLedgerActionKind, PlanLedgerStepStatus } from './plan-ledger-parser'
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
const localIdStyle: React.CSSProperties = { overflowWrap: 'anywhere', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }
