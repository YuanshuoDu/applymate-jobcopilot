'use client'

import React from 'react'

import { useI18n } from '@/lib/i18n'

import type { CognitiveAgendaAction, CognitiveAgendaBlocker, CognitiveAgendaSignal, CognitiveAgendaView } from './cognitive-agenda-view'
import type { TimelineCognitiveAgendaEntry } from './timeline-cognitive-agenda'
import type { TimelineSteeringMarkerState } from './timeline-steering-markers'

export interface CognitiveAgendaTaskLabel {
  readonly label: string
  readonly root: boolean
}

export interface CognitiveAgendaCardProps {
  readonly agenda: CognitiveAgendaView & { readonly steeringMarkers?: TimelineSteeringMarkerState }
  readonly agendas?: readonly TimelineCognitiveAgendaEntry[]
  readonly taskLabels?: ReadonlyMap<string, CognitiveAgendaTaskLabel>
}

const ACTION_KEYS: Record<CognitiveAgendaAction, string> = {
  apply_fresh_steering: 'agent.cognitiveAgenda.action.applyFreshSteering', resolve_pending_input: 'agent.cognitiveAgenda.action.resolvePendingInput', await_approval: 'agent.cognitiveAgenda.action.awaitApproval', await_children: 'agent.cognitiveAgenda.action.awaitChildren', continue_turn: 'agent.cognitiveAgenda.action.continueTurn',
}
const BLOCKER_KEYS: Record<CognitiveAgendaBlocker, string> = {
  fresh_steering: 'agent.cognitiveAgenda.blocker.freshSteering', pending_input: 'agent.cognitiveAgenda.blocker.pendingInput', approval: 'agent.cognitiveAgenda.blocker.approval', child_wait: 'agent.cognitiveAgenda.blocker.childWait', unresolved_failure: 'agent.cognitiveAgenda.blocker.unresolvedFailure',
}

export function CognitiveAgendaCard({ agenda, agendas = [], taskLabels }: CognitiveAgendaCardProps) {
  const { t } = useI18n()
  const signals: Array<[string, CognitiveAgendaSignal]> = [
    [t('agent.cognitiveAgenda.signal.pendingInputs'), agenda.signals.pendingInputs],
    [t('agent.cognitiveAgenda.signal.approvals'), agenda.signals.approvals],
    [t('agent.cognitiveAgenda.signal.activeWaits'), agenda.signals.activeWaits],
    [t('agent.cognitiveAgenda.signal.unresolved'), agenda.signals.unresolved],
    [t('agent.cognitiveAgenda.signal.steeringActive'), agenda.signals.steering.active],
    [t('agent.cognitiveAgenda.signal.steeringNewlyObserved'), agenda.signals.steering.newlyObserved],
  ]
  const blocker = agenda.blockedBy.kind ? t(BLOCKER_KEYS[agenda.blockedBy.kind]) : t('agent.cognitiveAgenda.none')
  const scopedRows = scopedAgendaRows(agendas, agenda, taskLabels).slice(0, 6)
  return (
    <section data-agent-cognitive-agenda="true" aria-label={t('agent.cognitiveAgenda.title')} style={cardStyle}>
      <div style={headingStyle}><strong>{t('agent.cognitiveAgenda.brain')}</strong><span style={metaStyle}>{t('agent.cognitiveAgenda.serverOwned')}</span></div>
      <div style={rowStyle}><span>{t('agent.cognitiveAgenda.nextAction')}</span><strong>{t(ACTION_KEYS[agenda.nextAction])}</strong></div>
      <div style={rowStyle}><span>{t('agent.cognitiveAgenda.blockedBy')}</span><span>{blocker}</span></div>
      <div style={signalsStyle}>{signals.map(([label, signal]) => <span key={label}>{label}: {signal.count}</span>)}</div>
      {agenda.steeringMarkers && <div data-agent-steering-lifecycle="true" style={signalsStyle}>
        <span>{t('agent.cognitiveAgenda.steering.observed')}: {agenda.steeringMarkers.observedCount}</span>
        <span>{t('agent.cognitiveAgenda.steering.active')}: {agenda.steeringMarkers.activeCount}</span>
        <span>{t('agent.cognitiveAgenda.steering.applied')}: {agenda.steeringMarkers.appliedCount}</span>
      </div>}
      {scopedRows.length > 0 && <div data-agent-cognitive-agendas="true" style={scopedStyle}>
        <strong>{t('agent.cognitiveAgenda.scopedTitle')}</strong>
        {scopedRows.map((row, index) => <div key={`${row.entry.turnId}:${row.entry.taskId}`} style={rowStyle}>
          <span>{t(row.kind)} · {row.label || `${t('agent.cognitiveAgenda.task')} ${index + 1}`}</span>
          <strong>{t(ACTION_KEYS[row.entry.latest.nextAction])}</strong>
        </div>)}
      </div>}
    </section>
  )
}

function scopedAgendaRows(
  agendas: readonly TimelineCognitiveAgendaEntry[],
  current: CognitiveAgendaView,
  taskLabels?: ReadonlyMap<string, CognitiveAgendaTaskLabel>,
): Array<{ entry: TimelineCognitiveAgendaEntry; label: string; kind: string }> {
  const currentEntry = agendas.find(entry => entry.turnId === current.turnId && entry.taskId === current.taskId)
  const rootEntry = agendas.find(entry => taskLabels?.get(entry.taskId)?.root)
  const ordered = [...agendas.filter(entry => entry === rootEntry || entry === currentEntry), ...agendas.filter(entry => entry !== rootEntry && entry !== currentEntry)]
  return ordered.map(entry => ({
    entry,
    label: safeTaskLabel(taskLabels?.get(entry.taskId)?.label ?? ''),
    kind: entry === rootEntry ? 'agent.cognitiveAgenda.root' : entry === currentEntry ? 'agent.cognitiveAgenda.current' : 'agent.cognitiveAgenda.child',
  }))
}

function safeTaskLabel(value: string): string {
  return /^[A-Za-z][A-Za-z /_-]{0,39}$/.test(value.trim()) ? value.trim() : ''
}

const cardStyle: React.CSSProperties = { display: 'grid', gap: 7, marginBottom: 10, padding: 10, border: '1px solid var(--border)', borderRadius: 9, background: 'var(--bg)' }
const headingStyle: React.CSSProperties = { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, fontSize: 12 }
const metaStyle: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 9 }
const rowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 8, color: 'var(--text-muted)', fontSize: 10 }
const signalsStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3, color: 'var(--text-muted)', fontSize: 9 }
const scopedStyle: React.CSSProperties = { display: 'grid', gap: 4, paddingTop: 5, borderTop: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 9 }
