'use client'

import React from 'react'
import { redactSensitiveValue } from '@jobcopilot/shared'
import { useI18n } from '@/lib/i18n'
import type { TimelineItem } from './timeline-reducer'
import { contentParts, itemText, type HarnessContentPart, type SuggestedActionCommand } from './harness-item-types'
import { HarnessMarkdown } from './HarnessMarkdown'

export interface HarnessItemProps {
  item: TimelineItem
  highlightedFinal?: boolean
  onSuggestedAction?: (command: SuggestedActionCommand) => void
}

export interface PlanStep {
  id: string
  label: string
  status: string
}

export function HarnessItem({ item, highlightedFinal = false, onSuggestedAction }: HarnessItemProps) {
  const { t } = useI18n()
  const final = item.phase === 'final_answer'
  const accent = final ? 'var(--c-success)' : item.type === 'reasoning_summary' ? '#7c3aed' : 'var(--primary)'
  const title = itemTitle(item.type, t)

  return (
    <article
      data-agent-harness-item={item.id}
      data-agent-item-type={item.type}
      data-agent-phase={final ? 'final' : 'commentary'}
      data-agent-final={highlightedFinal && final ? 'true' : 'false'}
      style={{
        flexShrink: 0, border: `1px solid ${highlightedFinal && final ? accent : 'var(--border)'}`,
        borderLeft: `4px solid ${accent}`, borderRadius: 10,
        background: highlightedFinal && final ? 'var(--bg-secondary)' : 'var(--bg)',
        padding: highlightedFinal && final ? '17px 19px' : '15px 18px',
        boxShadow: highlightedFinal && final ? 'var(--shadow-md)' : 'var(--shadow-sm)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 11 }}>
        <strong style={{ color: accent, fontSize: highlightedFinal && final ? 14 : 13 }}>{itemActor(item, t)}</strong>
        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{title}</span>
        {final && <span data-agent-final-label="true" style={{ marginLeft: 'auto', color: accent, fontSize: 10, fontWeight: 700 }}>{t('agent.finalAnswer')}</span>}
      </div>
      {renderItemBody(item, t, onSuggestedAction)}
      <div style={{ marginTop: 11, paddingTop: 8, borderTop: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 10 }}>
        {t('agent.itemStatus')}: {item.status}
      </div>
    </article>
  )
}

export function reducePlanSteps(value: unknown): PlanStep[] {
  const source = isRecord(value) ? value.steps ?? value.plan : value
  if (!Array.isArray(source)) return []
  return source.map((entry, index) => {
    if (typeof entry === 'string') return { id: String(index), label: entry, status: 'queued' }
    if (!isRecord(entry)) return null
    const label = stringValue(entry.label) ?? stringValue(entry.title) ?? stringValue(entry.name)
    if (!label) return null
    return { id: stringValue(entry.id) ?? String(index), label, status: stringValue(entry.status) ?? 'queued' }
  }).filter((step): step is PlanStep => step !== null)
}

function renderItemBody(item: TimelineItem, t: (key: string) => string, onSuggestedAction?: HarnessItemProps['onSuggestedAction']) {
  if (item.type === 'plan') return <PlanBody item={item} t={t} />
  if (item.type === 'tool_call' || item.type === 'tool_result') return <ToolLifecycleCard item={item} t={t} />
  if (item.type === 'reasoning_summary') {
    return <details><summary style={{ cursor: 'pointer', color: '#7c3aed', fontSize: 12 }}>{t('agent.reasoningSummary')}</summary><div style={{ marginTop: 8 }}><HarnessMarkdown markdown={itemText(item) || t('agent.noReasoningSummary')} /></div></details>
  }
  if (item.type === 'unknown') return <Fallback label={t('agent.unknownItem')} />
  return <div style={{ display: 'grid', gap: 8 }}>{contentParts(item.content).map((part, index) => <ContentPart key={index} part={part} t={t} onSuggestedAction={onSuggestedAction} />)}</div>
}

function PlanBody({ item, t }: { item: TimelineItem; t: (key: string) => string }) {
  const steps = reducePlanSteps(item.content)
  if (steps.length === 0) return <Fallback label={t('agent.planUnavailable')} />
  return (
    <div data-agent-plan="true" style={{ display: 'grid', gap: 7 }}>
      {steps.map(step => <div key={step.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12 }}><span aria-hidden="true" style={{ color: step.status === 'completed' || step.status === 'passed' ? 'var(--c-success)' : 'var(--text-muted)' }}>{step.status === 'completed' || step.status === 'passed' ? '✓' : '○'}</span><span style={{ flex: 1 }}>{step.label}</span><span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{step.status}</span></div>)}
    </div>
  )
}

export function ToolLifecycleCard({ item, t }: { item: TimelineItem; t?: (key: string) => string }) {
  const translate = t ?? ((key: string) => key)
  const data = isRecord(item.content) ? item.content : {}
  const toolName = stringValue(data.toolName) ?? stringValue(data.name) ?? (item.type === 'tool_result' ? translate('agent.toolResult') : translate('agent.toolCall'))
  const output = data.output ?? data.result ?? data.errorCode
  return (
    <div data-tool-lifecycle="true" data-tool-status={item.status} style={{ border: '1px solid var(--border)', borderRadius: 7, padding: '9px 10px', display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11 }}><strong>{toolName}</strong><span style={{ color: item.status === 'failed' ? 'var(--c-danger)' : item.status === 'completed' ? 'var(--c-success)' : 'var(--primary)' }}>{toolStatus(item.status, translate)}</span></div>
      {data.input !== undefined && <ValueRow label={translate('agent.toolInput')} value={data.input} />}
      {output !== undefined && <ValueRow label={item.status === 'failed' ? translate('agent.toolError') : translate('agent.toolOutput')} value={output} />}
    </div>
  )
}

function ContentPart({ part, t, onSuggestedAction }: { part: HarnessContentPart; t: (key: string) => string; onSuggestedAction?: HarnessItemProps['onSuggestedAction'] }) {
  if (part.type === 'text') return <HarnessMarkdown markdown={part.text} />
  if (part.type === 'redacted') return <Fallback label={t('agent.redactedContent')} />
  if (part.type === 'unknown') return <Fallback label={t('agent.unknownContentPart')} />
  if (part.type === 'suggested_action') return <button type="button" data-suggested-action={part.command} onClick={() => onSuggestedAction?.({ command: part.command, arguments: part.arguments })} style={{ justifySelf: 'start', border: '1px solid var(--primary)', borderRadius: 7, padding: '7px 10px', background: 'var(--bg-secondary)', color: 'var(--primary)', cursor: 'pointer', font: 'inherit', fontSize: 11 }}>{t('agent.suggestedAction')}: {part.command}</button>
  if (part.type === 'attachment_ref') return <InfoRow label={t('agent.attachment')} value={`${part.artifactId} · ${part.hash}`} />
  if (part.type === 'artifact_card') return <InfoRow label={t('agent.artifact')} value={`${part.label} · ${part.artifactId}`} />
  if (part.type === 'citation') return <InfoRow label={t('agent.citation')} value={`${part.label} · ${part.evidenceId}`} />
  return <InfoRow label={t('agent.jobTable')} value={`${part.jobIds.length} · ${part.columns.join(', ') || t('agent.noColumns')}`} />
}

function ValueRow({ label, value }: { label: string; value: unknown }) { return <InfoRow label={label} value={safeJson(value)} /> }
function InfoRow({ label, value }: { label: string; value: string }) { return <div style={{ display: 'grid', gridTemplateColumns: '92px 1fr', gap: 8, color: 'var(--text-muted)', fontSize: 10 }}><span>{label}</span><span style={{ color: 'var(--text)', overflowWrap: 'anywhere' }}>{value}</span></div> }
function Fallback({ label }: { label: string }) { return <div data-agent-fallback="true" style={{ color: 'var(--text-muted)', fontSize: 11 }}>{label}</div> }

function itemTitle(type: string, t: (key: string) => string) { return ({ agent_message: t('agent.messageTitle'), plan: t('agent.plan'), tool_call: t('agent.toolCall'), tool_result: t('agent.toolResult'), reasoning_summary: t('agent.reasoningSummary'), unknown: t('agent.unknownItem') } as Record<string, string>)[type] ?? t('agent.harnessItem') }
function itemActor(item: TimelineItem, t: (key: string) => string) { return item.type === 'tool_call' || item.type === 'tool_result' ? t('agent.toolActor') : item.type === 'user_message' ? t('agent.you') : item.type === 'reasoning_summary' ? t('agent.agentActor') : t('agent.orchestratorActor') }
function toolStatus(status: string, t: (key: string) => string) { return ({ started: t('agent.toolStarted'), running: t('agent.toolRunning'), streaming: t('agent.toolRunning'), completed: t('agent.toolCompleted'), failed: t('agent.toolFailed'), interrupted: t('agent.toolCancelled') } as Record<string, string>)[status] ?? status }
function safeJson(value: unknown) { try { const redacted = redactSensitiveValue(value, null, 0, 4); const serialized = JSON.stringify(redacted) ?? String(redacted); return serialized.length > 600 ? `${serialized.slice(0, 597)}...` : serialized } catch { return '[unavailable]' } }
function stringValue(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
