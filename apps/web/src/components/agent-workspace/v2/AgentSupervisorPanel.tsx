'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useApi } from '@/lib/hooks'
import { useI18n } from '@/lib/i18n'

import { flattenTaskTree, TaskTreePanel } from './TaskTreePanel'
import { AgentSessionControlBar } from './AgentSessionControlBar'
import { AgentTurnRetryControl } from './AgentTurnRetryControl'
import { CognitiveAgendaCard, type CognitiveAgendaTaskLabel } from './cognitive-agenda-card'
import { AgentPlanLedgerCard } from './AgentPlanLedgerCard'
import { AgentApprovalLedgerCard } from './AgentApprovalLedgerCard'
import { AgentContextCompactionCard } from './AgentContextCompactionCard'
import { AgentQuestionInputCard } from './AgentQuestionInputCard'
import { projectSupervisorTree, type SupervisorTaskSummary, type SupervisorTurnSummary } from './task-tree-projection'
import type { AgentTimelineSnapshot } from './use-agent-timeline'

interface PageInfo { hasMore?: boolean; nextCursor?: string | null }
interface TurnsResponse { turns?: SupervisorTurnSummary[]; page?: PageInfo }
interface TasksResponse { tasks?: SupervisorTaskSummary[]; page?: PageInfo }

export interface AgentSupervisorPanelProps {
  readonly sessionId: string | null
  readonly timeline: AgentTimelineSnapshot
}

/** V2 evidence panel with session controls owned by the timeline gate. */
export function AgentSupervisorPanel({ sessionId, timeline }: AgentSupervisorPanelProps) {
  const { t } = useI18n()
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [extraTurns, setExtraTurns] = useState<SupervisorTurnSummary[]>([])
  const [extraTasks, setExtraTasks] = useState<SupervisorTaskSummary[]>([])
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
  const encodedSessionId = sessionId ? encodeURIComponent(sessionId) : ''
  const turnsQuery = useApi<TurnsResponse>(
    sessionId ? `/api/agent/sessions/${encodedSessionId}/turns?limit=100` : '',
    { enabled: Boolean(sessionId) },
  )
  const tasksQuery = useApi<TasksResponse>(
    sessionId ? `/api/agent/sessions/${encodedSessionId}/tasks?limit=100` : '',
    { enabled: Boolean(sessionId) },
  )
  const previousLifecycleKey = useRef<string | null>(null)
  const sessionEpochRef = useRef(0)

  useEffect(() => {
    sessionEpochRef.current += 1
    setSelectedId(undefined)
    setExtraTurns([])
    setExtraTasks([])
    setLoadMoreError(null)
    previousLifecycleKey.current = null
  }, [sessionId])

  const turns = useMemo(() => (sessionId ? [...(turnsQuery.data?.turns ?? []), ...extraTurns].filter(turn => turn.sessionId === sessionId) : []), [sessionId, turnsQuery.data, extraTurns])
  const tasks = useMemo(() => (sessionId ? [...(tasksQuery.data?.tasks ?? []), ...extraTasks].filter(task => task.sessionId === sessionId) : []), [sessionId, tasksQuery.data, extraTasks])
  const lifecycleKey = String(timeline.lifecycleRevision)

  const { data: turnsData, refetch: refetchTurns } = turnsQuery
  const { data: tasksData, refetch: refetchTasks } = tasksQuery
  const turnsPage = turnsQuery.data?.page
  const tasksPage = tasksQuery.data?.page
  const hasMore = Boolean(turnsPage?.hasMore || tasksPage?.hasMore)

  const loadMore = useCallback(async () => {
    if (!sessionId || loadingMore || !hasMore) return
    const epoch = sessionEpochRef.current
    setLoadingMore(true)
    setLoadMoreError(null)
    try {
      const requests: Array<{ kind: 'turns' | 'tasks'; cursor: string }> = []
      if (turnsPage?.hasMore && turnsPage.nextCursor) requests.push({ kind: 'turns', cursor: turnsPage.nextCursor })
      if (tasksPage?.hasMore && tasksPage.nextCursor) requests.push({ kind: 'tasks', cursor: tasksPage.nextCursor })
      const responses = await Promise.all(requests.map(async request => {
        const query = new URLSearchParams({ limit: '100', cursor: request.cursor })
        const response = await fetch(`/api/agent/sessions/${encodedSessionId}/${request.kind}?${query}`)
        const body = await response.json().catch(() => null) as unknown
        if (!response.ok) throw new Error(`${request.kind} page failed (${response.status})`)
        return { kind: request.kind, body }
      }))
      if (epoch !== sessionEpochRef.current) return
      for (const response of responses) {
        if (response.kind === 'turns') {
          const body = response.body as TurnsResponse
          setExtraTurns(current => [...current, ...(body.turns ?? [])])
        } else {
          const body = response.body as TasksResponse
          setExtraTasks(current => [...current, ...(body.tasks ?? [])])
        }
      }
    } catch (reason) {
      if (epoch === sessionEpochRef.current) setLoadMoreError(reason instanceof Error ? reason.message : 'Could not load more supervisor records')
    } finally {
      if (epoch === sessionEpochRef.current) setLoadingMore(false)
    }
  }, [encodedSessionId, hasMore, loadingMore, sessionId, tasksPage?.hasMore, tasksPage?.nextCursor, turnsPage?.hasMore, turnsPage?.nextCursor])

  useEffect(() => {
    if (!sessionId) return
    if (previousLifecycleKey.current === null) {
      previousLifecycleKey.current = lifecycleKey
      return
    }
    if (previousLifecycleKey.current === lifecycleKey) return
    previousLifecycleKey.current = lifecycleKey
    if (turnsData || tasksData) {
      refetchTurns()
      refetchTasks()
    }
  }, [lifecycleKey, sessionId, tasksData, turnsData, refetchTasks, refetchTurns])

  const nodes = useMemo(() => projectSupervisorTree({
    turns,
    items: timeline.items,
    tasks,
    labels: { task: t('agent.tasks'), step: t('agent.plan'), tool: t('agent.toolActor') },
  }), [t, turns, timeline.items, tasks])
  const agendaTaskLabels = useMemo(() => new Map<string, CognitiveAgendaTaskLabel>(tasks.map(task => [task.id, {
    label: safeAgendaTaskLabel(task.role) || safeAgendaTaskLabel(task.taskType),
    root: !task.parentTaskId,
  }])), [tasks])
  const selectedNode = useMemo(() => flattenTaskTree(nodes).find(node => node.id === selectedId), [nodes, selectedId])
  const selectedTurn = useMemo(() => selectedNode?.kind === 'turn' && selectedNode.id.startsWith('turn:')
    ? turns.find(turn => `turn:${turn.id}` === selectedNode.id) ?? null
    : null, [selectedNode, turns])
  const selectedItem = selectedNode?.itemId ? timeline.items.find(item => item.id === selectedNode.itemId) : undefined
  const loading = Boolean(sessionId && (timeline.restoring || turnsQuery.loading || tasksQuery.loading))
  const error = timeline.error ?? turnsQuery.error ?? tasksQuery.error
  const refetchSupervisorRecords = useCallback(() => {
    refetchTurns()
    refetchTasks()
  }, [refetchTasks, refetchTurns])

  if (!sessionId) return null

  return (
    <aside className="agent-supervisor-panel" aria-label={t('agent.tasks')} data-agent-supervisor-panel="true">
      <style>{`
        .agent-supervisor-panel {
          width: min(310px, 30vw);
          min-width: 260px;
          min-height: 0;
          overflow-y: auto;
          padding: 14px;
          border-left: 1px solid var(--border);
          background: var(--bg-tertiary);
        }
        .agent-supervisor-selection {
          display: grid;
          gap: 8px;
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid var(--border);
        }
        @media (max-width: 900px) {
          .agent-supervisor-panel {
            width: auto;
            min-width: 0;
            max-height: 42vh;
            border-left: 0;
            border-top: 1px solid var(--border);
          }
        }
      `}</style>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 13, color: 'var(--text)' }}>{t('agent.tasks')}</h2>
        <span data-agent-supervisor-connection={timeline.connection} style={{ color: 'var(--text-muted)', fontSize: 10 }}>
          {connectionLabel(timeline.connection, t)}
        </span>
      </div>
      <AgentSessionControlBar sessionId={sessionId} controlGate={timeline.controlGate} controlRevision={timeline.controlRevision} />
      <SupervisorControlSummary controlGate={timeline.controlGate} controlRevision={timeline.controlRevision} t={t} />
      {loading && <p aria-live="polite" style={messageStyle}>{t('agent.loadingTasks')}</p>}
      {error && <p role="alert" style={{ ...messageStyle, color: 'var(--c-danger)' }}>{t('agent.supervisorUnavailable')}</p>}
      <AgentPlanLedgerCard ledger={timeline.planLedger} />
      <AgentApprovalLedgerCard ledger={timeline.approvalLedger} sessionId={sessionId} turns={turns} controlGate={timeline.controlGate} onAccepted={refetchSupervisorRecords} selectionKey={selectedId ?? ''} />
      <AgentContextCompactionCard ledger={timeline.contextCompaction} />
      <AgentQuestionInputCard sessionId={sessionId} items={timeline.items} turns={turns} controlGate={timeline.controlGate} onAccepted={refetchSupervisorRecords} selectionKey={selectedId ?? ''} />
      {timeline.cognitiveAgenda && <CognitiveAgendaCard agenda={timeline.cognitiveAgenda} agendas={timeline.cognitiveAgendas} taskLabels={agendaTaskLabels} />}
      {!loading && !nodes.length && !error && <p style={messageStyle}>{t('agent.noTaskRecords')}</p>}
      {!!nodes.length && <TaskTreePanel nodes={nodes} selectedId={selectedId} sessionKey={sessionId} showHeading={false} onSelect={setSelectedId} />}
      {hasMore && <button type="button" onClick={() => void loadMore()} disabled={loadingMore} style={loadMoreStyle}>
        {loadingMore ? t('agent.loadingMoreSupervisorRecords') : t('agent.loadMoreSupervisorRecords')}
      </button>}
      {loadMoreError && <p role="alert" style={{ ...messageStyle, color: 'var(--c-danger)' }}>{t('agent.loadMoreFailed')}</p>}
      {selectedNode && (
        <section className="agent-supervisor-selection" aria-label={selectedNode.label} data-agent-supervisor-selection="true">
          <div style={{ display: 'grid', gap: 4 }}>
            <strong style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{selectedNode.label}</strong>
            <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{t('agent.status')}: {statusLabel(selectedNode.status, t)}</span>
            {selectedNode.detail && <span style={{ color: 'var(--c-danger)', fontSize: 10, overflowWrap: 'anywhere' }}>{selectedNode.detail}</span>}
            {selectedNode.resultAvailable && <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{t('agent.toolResult')}</span>}
          </div>
          {selectedItem && <EvidenceSummary item={selectedItem} t={t} />}
          <AgentTurnRetryControl
            sessionId={sessionId}
            turn={selectedTurn}
            controlGate={timeline.controlGate}
            onAccepted={refetchSupervisorRecords}
          />
        </section>
      )}
    </aside>
  )
}

export function SupervisorControlSummary({ controlGate, controlRevision, t }: {
  readonly controlGate: AgentTimelineSnapshot['controlGate']
  readonly controlRevision: AgentTimelineSnapshot['controlRevision']
  readonly t: (key: string) => string
}) {
  const revision = Number.isSafeInteger(controlRevision) && controlRevision >= 0 ? String(controlRevision) : t('agent.notAvailable')
  return (
    <div data-agent-supervisor-control-state="true" data-agent-supervisor-control-gate={controlGate} data-agent-supervisor-control-revision={revision} style={controlSummaryStyle}>
      <span>{t('agent.gate')}: {controlGate === 'user_paused' ? t('agent.paused') : t('agent.running')}</span>
      <span>{t('agent.approvalLedger.revision')}: {revision}</span>
    </div>
  )
}

export interface SelectedEvidenceProjection {
  readonly itemId: string | null
  readonly type: string
  readonly status: string
  readonly toolName: string | null
  readonly toolCallId: string | null
  readonly resultAvailable: boolean
  readonly referenceIds: readonly string[]
}

/** Projects selected timeline evidence without traversing or rendering raw payload values. */
export function projectSelectedEvidence(item: NonNullable<AgentTimelineSnapshot['items']>[number]): SelectedEvidenceProjection {
  const base: SelectedEvidenceProjection = {
    itemId: safeStableId(item.id), type: safeToken(item.type) ?? 'unknown', status: safeToken(item.status) ?? 'unknown',
    toolName: null, toolCallId: null, resultAvailable: item.type === 'tool_result', referenceIds: [],
  }
  const content = projectEvidenceContent(item.content)
  return content ? { ...base, ...content } : base
}

export function EvidenceSummary({ item, t }: { item: NonNullable<AgentTimelineSnapshot['items']>[number]; t: (key: string) => string }) {
  const evidence = projectSelectedEvidence(item)
  return (
    <div data-agent-supervisor-evidence="true" style={{ display: 'grid', gap: 4, paddingTop: 8, color: 'var(--text-muted)', fontSize: 10 }}>
      <span>{t('agent.type')}: {itemTypeLabel(evidence.type, t)}{evidence.itemId ? ` · ${evidence.itemId}` : ''}</span>
      <span>{t('agent.itemStatus')}: {statusLabel(evidence.status, t)}</span>
      {item.completedAt && <span>{t('agent.complete')}: {new Date(item.completedAt).toLocaleString()}</span>}
      {evidence.toolName && <span>{t('agent.toolActor')}: {evidence.toolName}</span>}
      {evidence.toolCallId && <span>{t('agent.toolCall')}: {evidence.toolCallId}</span>}
      <span>{t('agent.toolResult')}: {evidence.resultAvailable ? t('agent.complete') : t('agent.notAvailable')}</span>
      {evidence.referenceIds.length > 0 && <span>{t('agent.citation')}: {evidence.referenceIds.join(', ')}</span>}
    </div>
  )
}

function itemTypeLabel(type: string, t: (key: string) => string): string {
  if (type === 'agent_message') return t('agent.messageTitle')
  if (type === 'plan') return t('agent.plan')
  if (type === 'tool_call') return t('agent.toolCall')
  if (type === 'tool_result') return t('agent.toolResult')
  if (type === 'reasoning_summary') return t('agent.reasoningSummary')
  return t('agent.harnessItem')
}

const MAX_EVIDENCE_STRING = 256, MAX_EVIDENCE_CONTENT = 4096, MAX_EVIDENCE_NODES = 96, MAX_EVIDENCE_ARRAY = 32, MAX_EVIDENCE_REFERENCES = 16, MAX_EVIDENCE_DEPTH = 5
const SAFE_EVIDENCE_KEYS = new Set(['artifactId', 'artifactRefs', 'columns', 'error', 'errorCode', 'evidenceId', 'evidenceIds', 'evidenceRefs', 'hash', 'input', 'jobId', 'jobIds', 'label', 'name', 'output', 'outputAvailable', 'outputSummary', 'parts', 'referenceId', 'referenceIds', 'references', 'result', 'resultAvailable', 'status', 'text', 'toolCallId', 'toolName', 'type'])
const OPAQUE_EVIDENCE_KEYS = new Set(['error', 'input', 'output', 'outputSummary', 'result'])
const SAFE_PART_TYPES = new Set(['artifact_card', 'attachment_ref', 'citation', 'job_table', 'redacted', 'text'])
const SENSITIVE_ID = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|credential|secret|bearer|session|user|lease|budget)/i
interface EvidenceContentProjection { toolName: string | null; toolCallId: string | null; resultAvailable?: boolean; referenceIds: string[] }
interface EvidenceBudget { characters: number; nodes: number }

function projectEvidenceContent(value: unknown): EvidenceContentProjection | null {
  try {
    const root = Array.isArray(value) ? { parts: value } : value
    if (!isPlainRecord(root) || !validateEvidenceValue(root, new Set(), 0, { characters: 0, nodes: 0 })) return null
    const toolName = optionalStableField(root, 'toolName', 'name'), toolCallId = optionalStableField(root, 'toolCallId', 'allowNull'), result = readOutputAvailability(root), referenceIds = readReferenceIds(root)
    return toolName.valid && toolCallId.valid && result.valid && referenceIds ? { toolName: toolName.value, toolCallId: toolCallId.value, ...(result.value === undefined ? {} : { resultAvailable: result.value }), referenceIds } : null
  } catch { return null }
}

function validateEvidenceValue(value: unknown, seen: Set<object>, depth: number, budget: EvidenceBudget): boolean {
  const kind = typeof value
  if (value === null || kind === 'boolean') return true
  if (typeof value === 'string') { budget.characters += value.length; return value.length <= MAX_EVIDENCE_STRING && budget.characters <= MAX_EVIDENCE_CONTENT }
  if (kind === 'number') return Number.isFinite(value)
  if (kind !== 'object' || depth >= MAX_EVIDENCE_DEPTH || seen.has(value as object)) return false
  const object = value as object
  seen.add(object)
  try {
    budget.nodes += 1
    if (budget.nodes > MAX_EVIDENCE_NODES) return false
    const keys = Reflect.ownKeys(object)
    if (Array.isArray(value)) return value.length <= MAX_EVIDENCE_ARRAY && keys.every(key => typeof key === 'string' && (key === 'length' || /^\d+$/.test(key))) && keys.filter((key): key is string => key !== 'length').every(key => validateEvidenceValue((value as unknown as Record<string, unknown>)[key], seen, depth + 1, budget))
    return isPlainRecord(value) && keys.length <= MAX_EVIDENCE_ARRAY && keys.every(key => typeof key === 'string' && key.length <= MAX_EVIDENCE_STRING && SAFE_EVIDENCE_KEYS.has(key) && (OPAQUE_EVIDENCE_KEYS.has(key) || validateEvidenceValue((value as Record<string, unknown>)[key], seen, depth + 1, budget)))
  } catch { return false } finally { seen.delete(object) }
}

function readReferenceIds(root: Record<string, unknown>): string[] | null {
  const references: string[] = [], add = (value: unknown): boolean => { const id = safeStableId(value); if (!id) return false; if (!references.includes(id)) references.push(id); return references.length <= MAX_EVIDENCE_REFERENCES }
  for (const key of ['artifactId', 'evidenceId', 'jobId', 'referenceId']) if (key in root && !add(root[key])) return null
  for (const key of ['artifactRefs', 'evidenceIds', 'evidenceRefs', 'referenceIds', 'references', 'jobIds']) if (key in root && (!Array.isArray(root[key]) || root[key].length > MAX_EVIDENCE_ARRAY || !root[key].every(add))) return null
  if ('parts' in root) {
    if (!Array.isArray(root.parts) || root.parts.length > MAX_EVIDENCE_ARRAY) return null
    for (const part of root.parts) {
      if (!isPlainRecord(part) || typeof part.type !== 'string' || !SAFE_PART_TYPES.has(part.type)) return null
      if ((part.type === 'citation' && !add(part.evidenceId)) || ((part.type === 'artifact_card' || part.type === 'attachment_ref') && !add(part.artifactId))) return null
      if ((part.type === 'text' && typeof part.text !== 'string') || (part.type === 'job_table' && (!Array.isArray(part.jobIds) || !part.jobIds.every(add)))) return null
    }
  }
  for (const key of ['output', 'result', 'outputSummary']) if (key in root) {
    const nested = readOpaqueReferenceIds(root[key])
    if (!nested || !nested.every(add)) return null
  }
  return references
}

function readOpaqueReferenceIds(value: unknown): string[] | null {
  if (!isPlainRecord(value)) return []
  const references: string[] = [], add = (candidate: unknown): boolean => { const id = safeStableId(candidate); if (!id) return false; if (!references.includes(id)) references.push(id); return references.length <= MAX_EVIDENCE_REFERENCES }
  try {
    for (const key of ['artifactId', 'evidenceId', 'jobId', 'referenceId']) if (key in value && !add(value[key])) return null
    for (const key of ['artifactRefs', 'evidenceIds', 'evidenceRefs', 'referenceIds', 'references', 'jobIds']) if (key in value && (!Array.isArray(value[key]) || value[key].length > MAX_EVIDENCE_ARRAY || !value[key].every(add))) return null
    return references
  } catch { return null }
}

function optionalStableField(root: Record<string, unknown>, ...keys: string[]): { valid: boolean; value: string | null } {
  const allowNull = keys.includes('allowNull')
  for (const key of keys.filter(candidate => candidate !== 'allowNull')) if (key in root) { const value = root[key]; if (allowNull && value === null) return { valid: true, value: null }; const id = safeStableId(value); return { valid: id !== null, value: id } }
  return { valid: true, value: null }
}
function readOutputAvailability(root: Record<string, unknown>): { valid: boolean; value?: boolean } {
  if ('resultAvailable' in root) return typeof root.resultAvailable === 'boolean' ? { valid: true, value: root.resultAvailable } : { valid: false }
  if ('outputAvailable' in root) return typeof root.outputAvailable === 'boolean' ? { valid: true, value: root.outputAvailable } : { valid: false }
  return ['output', 'result', 'outputSummary'].some(key => key in root) ? { valid: true, value: true } : { valid: true }
}
function safeStableId(value: unknown): string | null { if (typeof value !== 'string') return null; const trimmed = value.trim(); return !trimmed || trimmed.length > MAX_EVIDENCE_STRING || SENSITIVE_ID.test(trimmed) || trimmed.includes('://') || !/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/.test(trimmed) ? null : trimmed }
function safeToken(value: unknown): string | null { return typeof value === 'string' && value.length <= 64 && /^[A-Za-z][A-Za-z0-9_-]*$/.test(value) ? value : null }
function isPlainRecord(value: unknown): value is Record<string, unknown> { if (typeof value !== 'object' || value === null || Array.isArray(value)) return false; try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null } catch { return false } }

function connectionLabel(connection: AgentTimelineSnapshot['connection'], t: (key: string) => string): string {
  if (connection === 'connected') return t('agent.connected')
  if (connection === 'reconnecting') return t('agent.reconnecting')
  return t('agent.loading')
}

function statusLabel(status: string, t: (key: string) => string): string {
  if (status === 'queued' || status === 'retrying') return t('agent.queuedTasks')
  if (status === 'running' || status === 'in_progress' || status === 'started' || status === 'streaming') return t('agent.running')
  if (status.startsWith('waiting')) return t('agent.waiting')
  if (status === 'completed' || status === 'passed') return t('agent.done')
  if (status === 'failed' || status === 'error') return t('agent.errorTitle')
  if (status === 'interrupted' || status === 'cancelled') return t('agent.toolCancelled')
  if (status === 'paused') return t('agent.paused')
  return t('agent.unknownItem')
}

function safeAgendaTaskLabel(value: string): string {
  const trimmed = value.trim()
  return /^[A-Za-z][A-Za-z /_-]{0,39}$/.test(trimmed) ? trimmed : ''
}

const messageStyle: React.CSSProperties = { margin: 0, color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.45 }
const loadMoreStyle: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 7, padding: '7px 9px', background: 'var(--bg)', color: 'var(--primary)', cursor: 'pointer', font: 'inherit', fontSize: 10 }
const controlSummaryStyle: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 6, margin: '7px 0 10px', color: 'var(--text-muted)', fontSize: 9 }
