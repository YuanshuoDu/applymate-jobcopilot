import { expect, test } from './fixtures'
import type { Page, Response, Route } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { parsePlanLedger, projectPlanLedger, type PlanLedger } from '@jobcopilot/agent-protocol'
import { redactStreamEventPayload } from '../apps/web/src/lib/agent/session/stream-redaction'
import { taskGraphPlanLabel, type TaskGraphPlanLabelKey } from '../apps/web/src/lib/task-graph-plan-labels'

const SCHEMA = 'agent-harness.v2'
const GRAPH_SCHEMA = 'agent-harness.v2.task-graph'
const TRACE_SCHEMA = 'agent-harness.v2.plan-ledger-trace'
const SESSION_B = 'task-graph-session-b'
const TURN_B = 'task-graph-turn-b'
const GOAL_B = 'Compare engineering teams in Amsterdam'
const TIME = '2026-09-24T10:00:00.000Z'

type PersistedGraphNode = {
  key: string
  templateId: string
  goal: string
  successCriteria: string[]
  dependsOn: string[]
  depth: number
  taskId: string
}

type PersistedTaskGraphItem = {
  schemaVersion: string
  id: string
  sessionId: string
  turnId: string
  stepId: string | null
  taskId: string
  type: 'task_graph'
  status: string
  phase: string | null
  revision: number
  content: { schemaVersion: string; nodes: PersistedGraphNode[] }
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

type PersistedTaskRouteRow = {
  schemaVersion: string
  id: string
  sessionId: string
  turnId: string | null
  rootTaskId: string | null
  parentTaskId: string | null
  path: string
  role: string
  taskType: string
  status: string
  goal: string
  confidence: number | null
  failureReason: string | null
  hasResult: boolean
  structuredEvidencePreview?: unknown
  createdAt: string
  updatedAt: string
}

type PersistedGraphEvent = {
  schemaVersion: typeof SCHEMA
  id: string
  sessionId: string
  turnId: string
  itemId: string
  taskId: string
  type: 'item.delta'
  actor: string
  correlationId: string
  causationId: string | null
  idempotencyKey: string | null
  sequence: string
  payload: { kind: 'lifecycle' | 'proposal'; revision: number; item: PersistedTaskGraphItem; event?: Record<string, unknown> }
}

type PersistedPlanLedgerTrace = {
  schemaVersion: typeof TRACE_SCHEMA
  planLedger: PlanLedger
  rootTaskId: string
  graphItem: PersistedTaskGraphItem
  initialGraphItem: PersistedTaskGraphItem
  graphEvents: PersistedGraphEvent[]
  tasks: PersistedTaskRouteRow[]
}

type TaskGraphIdentity = {
  sessionId: string
  graphItemId: string
  turnId: string
  rootTaskId: string
  revision: number
}

type PlanLedgerResponse = {
  identity: TaskGraphIdentity
  projection: PlanLedger
}

type AcceptedTaskLookup = {
  sessionId: string
  taskIds: string[]
  identity: TaskGraphIdentity
}

type TaskLookupDiagnostic = {
  mode: 'default' | 'live' | 'snapshot-tail'
  session: 'trace' | 'other'
  selectors: TaskGraphSelectorResult['kind']
  revision: number | null
  identityMatchesFinalTrace: boolean | null
  taskIdCount: number
  taskIdsMatchFinalTrace: boolean
  outcome: 'pending' | 'task_list' | 'invalid_task_ids' | 'invalid_selectors' | 'missing_task_ids' | 'unversioned' | 'identity_or_task_ids_mismatch' | 'ledger_unavailable' | 'ledger_returned'
}

type TaskGraphSelectorResult =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'legacy'; revision: number }
  | { kind: 'complete'; identity: TaskGraphIdentity }

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function planLedgerEnumLabel(locale: 'en' | 'zh', group: 'readiness' | 'status', value: string): string {
  const suffix = value.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
  return taskGraphPlanLabel(locale, `agent.taskGraph.${group}.${suffix}` as TaskGraphPlanLabelKey)
}

function isPersistedGraphNode(value: unknown): value is PersistedGraphNode {
  const node = record(value)
  return !!node && typeof node.key === 'string' && typeof node.templateId === 'string' && typeof node.goal === 'string'
    && typeof node.taskId === 'string' && Number.isSafeInteger(node.depth)
    && Array.isArray(node.successCriteria) && node.successCriteria.every(value => typeof value === 'string')
    && Array.isArray(node.dependsOn) && node.dependsOn.every(value => typeof value === 'string')
}

function parsePersistedGraphItem(value: unknown): PersistedTaskGraphItem | null {
  const item = record(value)
  const content = record(item?.content)
  const nodes = Array.isArray(content?.nodes) && content.nodes.every(isPersistedGraphNode) ? content.nodes : null
  if (!item || item.schemaVersion !== SCHEMA || typeof item.id !== 'string' || typeof item.sessionId !== 'string'
    || typeof item.turnId !== 'string' || item.type !== 'task_graph' || typeof item.taskId !== 'string'
    || !Number.isSafeInteger(item.revision) || !content || content.schemaVersion !== GRAPH_SCHEMA || !nodes
    || typeof item.status !== 'string' || (item.phase !== null && typeof item.phase !== 'string')
    || (item.stepId !== null && typeof item.stepId !== 'string')
    || ![item.startedAt, item.completedAt].every(value => value === null || typeof value === 'string')
    || typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string') return null
  return { ...item, content: { schemaVersion: GRAPH_SCHEMA, nodes } } as unknown as PersistedTaskGraphItem
}

function isValidPersistedGraphEventTaskId(
  event: Record<string, unknown> | null,
  payload: Record<string, unknown> | null,
  item: PersistedTaskGraphItem | null,
  rootTaskId: string,
): boolean {
  if (!event || !payload || !item) return false
  if (payload.kind === 'proposal') return event.taskId === rootTaskId
  if (payload.kind !== 'lifecycle') return false
  const nodeKey = record(payload.event)?.nodeKey
  return typeof nodeKey === 'string'
    && item.content.nodes.some(node => node.key === nodeKey && node.taskId === event.taskId)
}

function parsePersistedTrace(value: unknown): PersistedPlanLedgerTrace | null {
  const envelope = record(value)
  const ledger = parsePlanLedger(envelope?.planLedger)
  const graphItem = parsePersistedGraphItem(envelope?.graphItem)
  const initialGraphItem = parsePersistedGraphItem(envelope?.initialGraphItem)
  const content = graphItem?.content
  const nodes = content?.nodes
  const initialContent = initialGraphItem?.content
  const initialNodes = initialContent?.nodes
  const rawGraphEvents = Array.isArray(envelope?.graphEvents) ? envelope.graphEvents.map(record) : null
  const rawTasks = Array.isArray(envelope?.tasks) ? envelope.tasks.map(record) : null
  const rootTaskId = envelope?.rootTaskId
  if (envelope?.schemaVersion !== TRACE_SCHEMA || !ledger || typeof rootTaskId !== 'string' || !graphItem || !content || !nodes || !rawTasks
    || graphItem.sessionId !== ledger.sessionId || graphItem.taskId !== rootTaskId
    || graphItem.revision !== ledger.revision
    || nodes.length !== ledger.nodes.length || nodes.some((node, index) => node.key !== ledger.nodes[index]?.key || node.goal !== ledger.nodes[index]?.goal)
    || !initialGraphItem || initialGraphItem.id !== graphItem.id || initialGraphItem.sessionId !== graphItem.sessionId
    || initialGraphItem.turnId !== graphItem.turnId || initialGraphItem.taskId !== rootTaskId
    || initialGraphItem.revision >= graphItem.revision || !initialContent || !initialNodes || initialNodes.length === 0
    || !rawGraphEvents || rawGraphEvents.length !== graphItem.revision - initialGraphItem.revision
    || !Array.isArray(rawTasks)) return null

  const graphEvents: PersistedGraphEvent[] = []
  let previousSequence = 0n
  for (let index = 0; index < rawGraphEvents.length; index += 1) {
    const event = rawGraphEvents[index]
    const payload = record(event?.payload)
    const item = parsePersistedGraphItem(payload?.item)
    const sequence = typeof event?.sequence === 'string' && /^(0|[1-9]\d*)$/.test(event.sequence)
      ? BigInt(event.sequence)
      : null
    const expectedRevision = initialGraphItem.revision + index + 1
    if (!event || event.schemaVersion !== SCHEMA || typeof event.id !== 'string'
      || event.sessionId !== graphItem.sessionId || event.turnId !== graphItem.turnId
      || event.itemId !== graphItem.id || !isValidPersistedGraphEventTaskId(event, payload, item, rootTaskId)
      || event.type !== 'item.delta'
      || typeof event.actor !== 'string' || typeof event.correlationId !== 'string'
      || (event.causationId !== null && typeof event.causationId !== 'string')
      || (event.idempotencyKey !== null && typeof event.idempotencyKey !== 'string')
      || sequence === null || sequence <= previousSequence
      || (payload?.kind !== 'lifecycle' && payload?.kind !== 'proposal')
      || payload.revision !== expectedRevision || !item || item.id !== graphItem.id
      || item.sessionId !== graphItem.sessionId || item.turnId !== graphItem.turnId
      || item.taskId !== rootTaskId || item.revision !== expectedRevision) return null
    previousSequence = sequence
    graphEvents.push(event as unknown as PersistedGraphEvent)
  }
  const lastGraphEventItem = parsePersistedGraphItem(record(graphEvents.at(-1)?.payload)?.item)
  if (!lastGraphEventItem || JSON.stringify(lastGraphEventItem.content) !== JSON.stringify(graphItem.content)) return null

  const tasks: PersistedTaskRouteRow[] = []
  for (const task of rawTasks) {
    if (!task || task.schemaVersion !== SCHEMA || typeof task.id !== 'string' || task.sessionId !== ledger.sessionId
      || task.turnId !== graphItem.turnId || typeof task.rootTaskId !== 'string'
      || task.rootTaskId !== rootTaskId || (task.parentTaskId !== null && typeof task.parentTaskId !== 'string')
      || typeof task.path !== 'string' || typeof task.role !== 'string' || typeof task.taskType !== 'string'
      || typeof task.status !== 'string' || typeof task.goal !== 'string' || typeof task.hasResult !== 'boolean'
      || (task.confidence !== null && typeof task.confidence !== 'number')
      || (task.failureReason !== null && typeof task.failureReason !== 'string')
      || typeof task.createdAt !== 'string' || typeof task.updatedAt !== 'string' || Object.hasOwn(task, 'result')) return null
    tasks.push(task as unknown as PersistedTaskRouteRow)
  }
  const persistedTaskIds = new Set(tasks.map(task => task.id))
  const root = tasks.find(task => task.id === rootTaskId)
  if (persistedTaskIds.size !== tasks.length || tasks.length !== nodes.length + 1 || !root || root.parentTaskId !== null
    || nodes.some(node => !persistedTaskIds.has(node.taskId)
      || tasks.find(task => task.id === node.taskId)?.parentTaskId !== rootTaskId)) return null

  return {
    schemaVersion: TRACE_SCHEMA,
    planLedger: ledger,
    rootTaskId,
    graphItem,
    initialGraphItem,
    graphEvents,
    tasks,
  }
}

// CI wraps the public ledger with persisted TaskGraph/task identities for this browser-only handoff.
const traceArtifactPath = process.env.AGENT_PLAN_LEDGER_TRACE_ARTIFACT_PATH
const traceArtifact = traceArtifactPath ? parsePersistedTrace(JSON.parse(readFileSync(traceArtifactPath, 'utf8')) as unknown) : null
if (traceArtifactPath && (!traceArtifact || traceArtifact.planLedger.revision < 2 || traceArtifact.planLedger.nodes.length < 2)) {
  throw new Error('The Worker process-restart trace artifact or its persisted identity envelope is missing or invalid.')
}

function json(route: Route, data: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) })
}

function taskGraphItem(sessionId: string, turnId: string, rootTaskId: string, id: string, nodeKey: string, childTaskId: string, goal: string, revision: number) {
  return {
    schemaVersion: SCHEMA,
    id,
    sessionId,
    turnId,
    stepId: null,
    taskId: rootTaskId,
    type: 'task_graph',
    status: 'streaming',
    phase: 'commentary',
    revision,
    content: {
      schemaVersion: GRAPH_SCHEMA,
      nodes: [{ key: nodeKey, templateId: 'scout', goal, successCriteria: ['Persist employer evidence'], dependsOn: [], depth: 1, taskId: childTaskId }],
    },
    startedAt: TIME,
    completedAt: null,
    createdAt: TIME,
    updatedAt: TIME,
    sequence: null,
  }
}

function graphIdentity(graph: PersistedTaskGraphItem): TaskGraphIdentity {
  return {
    sessionId: graph.sessionId,
    graphItemId: graph.id,
    turnId: graph.turnId,
    rootTaskId: graph.taskId,
    revision: graph.revision,
  }
}

function parseTaskGraphIdentity(value: unknown): TaskGraphIdentity | null {
  const identity = record(value)
  if (!identity || typeof identity.sessionId !== 'string' || typeof identity.graphItemId !== 'string'
    || typeof identity.turnId !== 'string' || typeof identity.rootTaskId !== 'string'
    || !Number.isSafeInteger(identity.revision)) return null
  return {
    sessionId: identity.sessionId,
    graphItemId: identity.graphItemId,
    turnId: identity.turnId,
    rootTaskId: identity.rootTaskId,
    revision: identity.revision as number,
  }
}

function graphTaskIds(graph: PersistedTaskGraphItem): string[] {
  return [...new Set([graph.taskId, ...graph.content.nodes.map(node => node.taskId)])]
}

function parseTaskGraphSelectors(url: URL, sessionId: string): TaskGraphSelectorResult {
  const names = ['graphItemId', 'graphTurnId', 'rootTaskId', 'graphRevision'] as const
  const values = names.map(name => url.searchParams.getAll(name))
  if (values.every(entries => entries.length === 0)) return { kind: 'none' }
  if (values.slice(0, 3).every(entries => entries.length === 0)) {
    const revisions = values[3]!
    const revision = Number(revisions[0])
    return revisions.length === 1 && revisions[0] !== '' && Number.isSafeInteger(revision)
      && revision > 0 && String(revision) === revisions[0]
      ? { kind: 'legacy', revision }
      : { kind: 'invalid' }
  }
  if (values.some(entries => entries.length !== 1 || entries[0] === '')) return { kind: 'invalid' }
  const [graphItemId, turnId, rootTaskId, revisionText] = values.map(entries => entries[0]!)
  const identifiers = [graphItemId, turnId, rootTaskId]
  const revision = Number(revisionText)
  if (identifiers.some(value => value.length > 128 || value.trim() !== value)
    || !Number.isSafeInteger(revision) || revision < 1 || String(revision) !== revisionText) return { kind: 'invalid' }
  return { kind: 'complete', identity: { sessionId, graphItemId, turnId, rootTaskId, revision } }
}

function sameIdentity(left: TaskGraphIdentity, right: TaskGraphIdentity): boolean {
  return left.sessionId === right.sessionId && left.graphItemId === right.graphItemId
    && left.turnId === right.turnId && left.rootTaskId === right.rootTaskId && left.revision === right.revision
}

function sameTaskIdSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left)
  return leftSet.size === left.length && leftSet.size === right.length && right.every(id => leftSet.has(id))
}

function persistedTask(
  sessionId: string,
  turnId: string,
  rootTaskId: string,
  id: string,
  parentTaskId: string | null,
  path: string,
  role: string,
  taskType: string,
  status: string,
  goal: string,
): PersistedTaskRouteRow {
  return {
    schemaVersion: SCHEMA,
    id,
    sessionId,
    turnId,
    rootTaskId,
    parentTaskId,
    path,
    role,
    taskType,
    status,
    goal,
    confidence: null,
    failureReason: null,
    hasResult: false,
    createdAt: TIME,
    updatedAt: TIME,
  }
}

function persistedTraceParserFixture(): PersistedPlanLedgerTrace {
  const sessionId = 'trace-parser-session'
  const turnId = 'trace-parser-turn'
  const rootTaskId = 'trace-parser-root'
  const childTaskId = 'trace-parser-child'
  const itemId = 'trace-parser-item'
  const nodeKey = 'trace-parser-node'
  const goal = 'Review employer profiles'
  const graphItem = parsePersistedGraphItem(taskGraphItem(sessionId, turnId, rootTaskId, itemId, nodeKey, childTaskId, goal, 3))
  const initialGraphItem = parsePersistedGraphItem(taskGraphItem(sessionId, turnId, rootTaskId, itemId, nodeKey, childTaskId, goal, 1))
  const proposalItem = parsePersistedGraphItem(taskGraphItem(sessionId, turnId, rootTaskId, itemId, nodeKey, childTaskId, goal, 2))
  if (!graphItem || !initialGraphItem || !proposalItem) throw new Error('Invalid persisted trace parser fixture item.')
  const graphEvent = (
    revision: number,
    taskId: string,
    kind: 'proposal' | 'lifecycle',
    item: PersistedTaskGraphItem,
    lifecycleEvent?: Record<string, unknown>,
  ): PersistedGraphEvent => ({
    schemaVersion: SCHEMA,
    id: `trace-parser-event-${revision}`,
    sessionId,
    turnId,
    itemId,
    taskId,
    type: 'item.delta',
    actor: 'orchestrator',
    correlationId: turnId,
    causationId: null,
    idempotencyKey: null,
    sequence: String(revision),
    payload: { kind, revision, item, ...(lifecycleEvent ? { event: lifecycleEvent } : {}) },
  })

  const planLedger: PlanLedger = {
    schemaVersion: 'agent-harness.v2.plan-ledger',
    sessionId,
    revision: 3,
    goal: 'Plan employer research',
    nodes: [{
      key: nodeKey,
      goal,
      status: 'running',
      resultAvailable: false,
      evidencePreview: null,
      readiness: 'active',
      dependencies: [],
    }],
  }
  const task = (id: string, parentTaskId: string | null, path: string, role: string, taskType: string, taskGoal: string) => ({
    schemaVersion: SCHEMA,
    id,
    sessionId,
    turnId,
    rootTaskId,
    parentTaskId,
    path,
    role,
    taskType,
    status: 'running',
    goal: taskGoal,
    confidence: null,
    failureReason: null,
    hasResult: false,
    createdAt: TIME,
    updatedAt: TIME,
  })

  return {
    schemaVersion: TRACE_SCHEMA,
    planLedger,
    rootTaskId,
    graphItem,
    initialGraphItem,
    graphEvents: [
      graphEvent(2, rootTaskId, 'proposal', proposalItem),
      graphEvent(3, childTaskId, 'lifecycle', graphItem, { type: 'task.started', nodeKey }),
    ],
    tasks: [
      task(rootTaskId, null, 'root', 'orchestrator', 'root', 'Plan employer research'),
      task(childTaskId, rootTaskId, 'root/research', 'scout', 'research', goal),
    ],
  }
}

async function installTaskGraphFixture(page: Page, persistedTrace: PersistedPlanLedgerTrace) {
  const persistedLedger = persistedTrace.planLedger
  const persistedGraphItem = persistedTrace.graphItem
  const SESSION_A = persistedLedger.sessionId
  const PLAN_REVISION = persistedLedger.revision
  const GOAL_A = persistedLedger.goal ?? persistedTrace.tasks.find(task => task.id === persistedTrace.rootTaskId)?.goal ?? 'Persisted TaskGraph plan'
  const expectedTaskIds = graphTaskIds(persistedGraphItem)
  const sessionAGraphs = [persistedTrace.initialGraphItem, ...persistedTrace.graphEvents
    .map(event => parsePersistedGraphItem(record(event.payload)?.item)), persistedGraphItem]
    .filter((graph): graph is PersistedTaskGraphItem => graph !== null)
    .filter((graph, index, graphs) => graphs.findIndex(candidate => sameIdentity(graphIdentity(candidate), graphIdentity(graph))) === index)
  const graphsBySession = new Map<string, PersistedTaskGraphItem[]>([[SESSION_A, sessionAGraphs]])
  const tasksBySession = new Map<string, PersistedTaskRouteRow[]>([[SESSION_A, persistedTrace.tasks]])
  let deliveryMode: 'default' | 'live' | 'snapshot-tail' = 'default'
  let releaseLiveDelta!: () => void
  const liveDeltaGate = new Promise<void>(resolve => { releaseLiveDelta = resolve })
  let releaseSnapshotTail!: () => void
  const snapshotTailGate = new Promise<void>(resolve => { releaseSnapshotTail = resolve })
  let releaseSnapshotClose!: () => void
  const snapshotCloseGate = new Promise<void>(resolve => { releaseSnapshotClose = resolve })
  const fixture = {
    sessionA: SESSION_A,
    planRevision: PLAN_REVISION,
    persistedLedger,
    traceGraphIdentities: sessionAGraphs.map(graphIdentity),
    expectedTaskIds,
    eventRequests: new Map<string, Array<string | null>>(),
    requestsByMode: new Map<string, Array<string | null>>(),
    planLedgers: new Map<string, PlanLedgerResponse | null>(),
    acceptedTaskLookups: [] as AcceptedTaskLookup[],
    taskLookupDiagnostics: [] as TaskLookupDiagnostic[],
    forbiddenApiRequests: [] as string[],
    externalRequests: [] as string[],
    setDeliveryMode(mode: 'live' | 'snapshot-tail') {
      deliveryMode = mode
    },
    releaseLiveDelta() { releaseLiveDelta() },
    releaseSnapshotClose() { releaseSnapshotClose() },
    releaseSnapshotTail() { releaseSnapshotTail() },
  }

  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== 'http://127.0.0.1:3100') {
      fixture.externalRequests.push(url.origin)
      return route.abort()
    }
    return route.fallback()
  })

  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const pathname = url.pathname
    const method = request.method()
    if (/\/(?:ai|apply|applications|gmail\/send)(?:\/|$)/i.test(pathname)) fixture.forbiddenApiRequests.push(pathname)

    if (pathname === '/api/auth/session') return json(route, {
      user: { id: 'task-graph-fixture-user', email: 'task-graph@applymate.local', name: 'Task Graph Fixture' },
      expires: '2099-01-01T00:00:00.000Z',
    })
    if (pathname === '/api/me') return json(route, { id: 'task-graph-fixture-user', email: 'task-graph@applymate.local', plan: 'pro', onboardedAt: TIME })
    if (pathname.startsWith('/api/jobs')) return json(route, { jobs: [], total: 0, page: 1, pageSize: 100, statusCounts: {} })
    if (pathname.startsWith('/api/resume')) return json(route, [])
    if (pathname === '/api/agent') return json(route, { autoApply: false, requireApproval: true, isRunning: false })
    if (pathname === '/api/agent/roles' || pathname === '/api/agent/roles/custom') return json(route, [])
    if (pathname === '/api/agent/automations') return json(route, { automations: [] })
    if (pathname === '/api/agent/health') return json(route, { successRate: 100, captchaRate: 0, avgDurationMs: 100, patternCacheRate: 100, last24hRuns: 0 })
    if (pathname.startsWith('/api/notifications')) return json(route, { notifications: [], unreadCount: 0 })
    if (pathname === '/api/gmail/unread') return json(route, { hasGmail: false, unread: 0 })

    if (pathname === '/api/agent/sessions') return json(route, {
      sessions: [
        { id: SESSION_A, goal: GOAL_A, status: 'running', updatedAt: TIME, memorySummary: 'Persisted plan A.' },
        { id: SESSION_B, goal: GOAL_B, status: 'running', updatedAt: TIME, memorySummary: 'No persisted TaskGraph data.' },
      ],
      lastOpenedSessionId: SESSION_A,
    })

    const parts = pathname.split('/').filter(Boolean)
    if (parts[0] === 'api' && parts[1] === 'agent' && parts[2] === 'sessions' && parts.length >= 4) {
      const sessionId = parts[3]!
      const turnId = sessionId === SESSION_A ? persistedGraphItem.turnId : TURN_B
      const goal = sessionId === SESSION_A ? GOAL_A : GOAL_B
      const resource = parts[4] ?? ''

      if (resource === 'events') {
        const requests = fixture.eventRequests.get(sessionId) ?? []
        requests.push(url.searchParams.get('afterSequence'))
        fixture.eventRequests.set(sessionId, requests)
        const modeKey = `${deliveryMode}:${sessionId}`
        const modeRequests = fixture.requestsByMode.get(modeKey) ?? []
        modeRequests.push(url.searchParams.get('afterSequence'))
        fixture.requestsByMode.set(modeKey, modeRequests)

        if (sessionId === SESSION_A && deliveryMode === 'live' && modeRequests.length === 1) {
          await liveDeltaGate
          return jsonSse(route, persistedTrace.graphEvents)
        }
        if (sessionId === SESSION_A && deliveryMode === 'snapshot-tail' && modeRequests.length === 1) {
          await snapshotCloseGate
          return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': task graph fixture stream closed before persisted event\n\n' })
        }
        if (sessionId === SESSION_A && deliveryMode === 'snapshot-tail' && modeRequests.length === 2) {
          await snapshotTailGate
          return jsonSse(route, persistedTrace.graphEvents)
        }
        if (sessionId === SESSION_A && requests.length === 1) {
          return jsonSse(route, persistedTrace.graphEvents)
        }
        // The finite fixture stream closes after each response; the real client must reconnect from its last sequence.
        await new Promise(resolve => setTimeout(resolve, 900))
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': task graph fixture stream\n\n' })
      }
      if (resource === 'timeline') {
        const items = sessionId === SESSION_A ? [persistedTrace.initialGraphItem] : []
        return json(route, { items, agenda: null, page: { hasMore: false, nextCursor: null } })
      }
      if (resource === 'tasks') {
        const requestedTaskIds = url.searchParams.getAll('taskId')
        const isTaskLookup = requestedTaskIds.length > 0
        const selectors = parseTaskGraphSelectors(url, sessionId)
        const diagnostic: TaskLookupDiagnostic = {
          mode: deliveryMode,
          session: sessionId === SESSION_A ? 'trace' : 'other',
          selectors: selectors.kind,
          revision: selectors.kind === 'complete' ? selectors.identity.revision : selectors.kind === 'legacy' ? selectors.revision : null,
          identityMatchesFinalTrace: selectors.kind === 'complete' ? sameIdentity(selectors.identity, graphIdentity(persistedGraphItem)) : null,
          taskIdCount: requestedTaskIds.length,
          taskIdsMatchFinalTrace: sameTaskIdSet(requestedTaskIds, expectedTaskIds),
          outcome: 'pending',
        }
        fixture.taskLookupDiagnostics.push(diagnostic)
        if (fixture.taskLookupDiagnostics.length > 8) fixture.taskLookupDiagnostics.shift()
        const invalidTaskIds = requestedTaskIds.length > 9
          || new Set(requestedTaskIds).size !== requestedTaskIds.length
          || requestedTaskIds.some(taskId => taskId.length < 1 || taskId.length > 128 || taskId.trim() !== taskId)
        if (invalidTaskIds) {
          diagnostic.outcome = 'invalid_task_ids'
          return json(route, { error: { code: 'invalid_task_ids', message: 'taskId values must be unique and bounded', details: {} } }, 400)
        }
        if (selectors.kind === 'invalid') {
          diagnostic.outcome = 'invalid_selectors'
          return json(route, { error: { code: 'invalid_task_graph_identity', message: 'TaskGraph selectors must be supplied once as a complete set', details: {} } }, 400)
        }
        if (selectors.kind !== 'none' && !isTaskLookup) {
          diagnostic.outcome = 'missing_task_ids'
          return json(route, { error: { code: 'task_graph_ids_required', message: 'TaskGraph lookup requires referenced task IDs', details: {} } }, 400)
        }

        const sessionTasks = tasksBySession.get(sessionId) ?? []
        if (!isTaskLookup) {
          diagnostic.outcome = 'task_list'
          return json(route, { tasks: sessionTasks, page: { hasMore: false, nextCursor: null } })
        }
        if (selectors.kind === 'none') {
          diagnostic.outcome = 'unversioned'
          const tasks = sessionTasks.filter(task => requestedTaskIds.includes(task.id))
          return json(route, { tasks, page: { hasMore: false, nextCursor: null } })
        }

        const graphCandidates = graphsBySession.get(sessionId) ?? []
        const selectedGraphs = selectors.kind === 'legacy'
          ? graphCandidates.filter(candidate => candidate.sessionId === sessionId && candidate.revision === selectors.revision)
          : graphCandidates.filter(candidate => sameIdentity(graphIdentity(candidate), selectors.identity))
        const graph = selectedGraphs.length === 1 ? selectedGraphs[0] : undefined
        if (!graph || !sameTaskIdSet(requestedTaskIds, graphTaskIds(graph))) {
          diagnostic.outcome = 'identity_or_task_ids_mismatch'
          return json(route, { tasks: [], planLedger: null, page: { hasMore: false, nextCursor: null } })
        }

        const taskIds = graphTaskIds(graph)
        const tasks = sessionTasks.filter(task => task.sessionId === sessionId && taskIds.includes(task.id))
        const projection = projectPlanLedger({ sessionId, revision: graph.revision, rootTaskId: graph.taskId, graph: graph.content, tasks })
        const planLedger: PlanLedgerResponse | null = projection
          ? { identity: graphIdentity(graph), projection }
          : null
        diagnostic.outcome = planLedger ? 'ledger_returned' : 'ledger_unavailable'
        fixture.acceptedTaskLookups.push({ sessionId, taskIds: requestedTaskIds, identity: graphIdentity(graph) })
        fixture.planLedgers.set(`${sessionId}:${graph.revision}`, planLedger)
        return json(route, { tasks, planLedger, page: { hasMore: false, nextCursor: null } })
      }
      if (resource === 'turns') return json(route, {
        turns: [{ id: turnId, sessionId, source: 'message', goal, status: 'in_progress', revision: 1, activeStepId: null, createdAt: TIME, updatedAt: TIME }],
        projection: { activeTurnId: turnId, activeTurn: { id: turnId, status: 'in_progress', revision: 1 }, queuedInputCount: 0 },
      })
      if (!resource && method === 'PATCH') return json(route, {})
      if (!resource) return json(route, { session: { id: sessionId, goal, status: 'running', updatedAt: TIME, tasks: [], approvals: [], applicationTasks: [], questions: [], artifacts: [], qualityScore: 100 } })
      return json(route, {})
    }
    return json(route, {})
  })

  return fixture
}

function isPlanLedgerResponseFor(response: Response, identity: TaskGraphIdentity): boolean {
  const request = response.request()
  if (request.method() !== 'GET') return false
  const url = new URL(response.url())
  const prefix = '/api/agent/sessions/'
  const suffix = '/tasks'
  if (!url.pathname.startsWith(prefix) || !url.pathname.endsWith(suffix)) return false
  let sessionId: string
  try {
    sessionId = decodeURIComponent(url.pathname.slice(prefix.length, -suffix.length))
  } catch {
    return false
  }
  if (sessionId !== identity.sessionId) return false
  const selectors = parseTaskGraphSelectors(url, sessionId)
  return selectors.kind === 'complete' && sameIdentity(selectors.identity, identity)
}

function recentTaskLookupDiagnostics(
  fixture: Awaited<ReturnType<typeof installTaskGraphFixture>>,
  mode: 'default' | 'live' | 'snapshot-tail',
): TaskLookupDiagnostic[] {
  return fixture.taskLookupDiagnostics
    .filter(lookup => lookup.mode === mode && lookup.session === 'trace')
    .slice(-8)
}

async function waitForPlanLedgerResponse(
  page: Page,
  identity: TaskGraphIdentity,
  fixture: Awaited<ReturnType<typeof installTaskGraphFixture>>,
  mode: 'default' | 'live' | 'snapshot-tail',
  label: string,
): Promise<PlanLedgerResponse> {
  let response: Response
  try {
    response = await page.waitForResponse(candidate => isPlanLedgerResponseFor(candidate, identity), { timeout: 10_000 })
  } catch (error) {
    const recentLookups = recentTaskLookupDiagnostics(fixture, mode)
    const errorText = (error instanceof Error ? error.message : 'Unknown Playwright response wait error')
      .replace(/https?:\/\/\S+|\/api\/agent\/\S+/gi, '[request]')
      .slice(0, 240)
    throw new Error(`${label}: no browser response for the expected session/revision ledger identity; recent sanitized lookups=${JSON.stringify(recentLookups)}; ${errorText}`)
  }

  if (response.status() !== 200) {
    const recentLookups = recentTaskLookupDiagnostics(fixture, mode)
    throw new Error(`${label}: matching task lookup returned HTTP ${response.status()}; recent sanitized lookups=${JSON.stringify(recentLookups)}`)
  }
  const body = record(await response.json())
  const rawLedger = record(body?.planLedger)
  const responseIdentity = parseTaskGraphIdentity(rawLedger?.identity)
  const projection = parsePlanLedger(rawLedger?.projection)
  if (!responseIdentity || !projection || !sameIdentity(responseIdentity, identity)
    || projection.sessionId !== identity.sessionId || projection.revision !== identity.revision) {
    const recentLookups = recentTaskLookupDiagnostics(fixture, mode)
    throw new Error(`${label}: browser received the exact selector request but it did not return the expected session/revision ledger; recent sanitized lookups=${JSON.stringify(recentLookups)}`)
  }
  return { identity: responseIdentity, projection }
}

function jsonSse(route: Route, events: readonly PersistedGraphEvent[]) {
  return route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: events.map(event => {
      const redactedEvent = {
        ...event,
        payload: redactStreamEventPayload(event.type, event.payload, {
          sessionId: event.sessionId,
          turnId: event.turnId,
          itemId: event.itemId,
          taskId: event.taskId,
        }),
      }
      return `event: ${event.type}\nid: ${event.sequence}\ndata: ${JSON.stringify(redactedEvent)}\n\n`
    }).join(''),
  })
}

async function readTaskGraphProjection(plan: ReturnType<Page['locator']>) {
  return plan.evaluate(element => ({
    sessionId: element.getAttribute('data-agent-task-graph-session'),
    revision: element.getAttribute('data-agent-task-graph-revision'),
    goal: element.querySelector('[data-agent-task-graph-goal="true"]')?.textContent?.trim() ?? null,
    nodes: Array.from(element.querySelectorAll('ol > li'), node => node.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
    evidence: Array.from(element.querySelectorAll('[data-task-graph-evidence="preview"]'), node => node.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
  }))
}

function requireProductionTraceArtifact(): PersistedPlanLedgerTrace {
  if (!traceArtifact) test.skip(true, 'Requires the disposable PostgreSQL Worker process-restart trace artifact.')
  return traceArtifact!
}

test('persisted Plan Ledger parser validates proposal and lifecycle task attribution', () => {
  const trace = persistedTraceParserFixture()
  expect(trace.graphEvents[0]?.taskId).toBe(trace.rootTaskId)
  expect(trace.graphEvents[1]?.taskId).toBe(trace.graphItem.content.nodes[0]?.taskId)
  expect(parsePersistedTrace(trace)).not.toBeNull()

  const mismatchedProposal = structuredClone(trace)
  mismatchedProposal.graphEvents[0] = { ...mismatchedProposal.graphEvents[0]!, taskId: trace.graphItem.content.nodes[0]!.taskId }
  expect(parsePersistedTrace(mismatchedProposal)).toBeNull()

  for (const taskId of [trace.rootTaskId, 'trace-parser-wrong-child']) {
    const mismatchedLifecycle = structuredClone(trace)
    mismatchedLifecycle.graphEvents[1] = { ...mismatchedLifecycle.graphEvents[1]!, taskId }
    expect(parsePersistedTrace(mismatchedLifecycle)).toBeNull()
  }

  const unknownLifecycleNode = structuredClone(trace)
  const lifecycleEvent = unknownLifecycleNode.graphEvents[1]!
  unknownLifecycleNode.graphEvents[1] = {
    ...lifecycleEvent,
    payload: { ...lifecycleEvent.payload, event: { ...lifecycleEvent.payload.event, nodeKey: 'unknown-node' } },
  }
  expect(parsePersistedTrace(unknownLifecycleNode)).toBeNull()
})

test('Plan Ledger restores the same persisted trace session after SSE reconnect without leaking across sessions', async ({ page }, testInfo) => {
  const persistedTrace = requireProductionTraceArtifact()
  const persistedLedger = persistedTrace.planLedger
  const locale = testInfo.project.name.endsWith('-zh') ? 'zh' : 'en'
  const dependentNode = persistedLedger.nodes.find(node => node.dependencies.length > 0)
  if (!dependentNode) throw new Error('Persisted Worker trace has no dependent Plan Ledger node.')
  const dependency = dependentNode.dependencies[0]
  if (!dependency || !dependency.status || !dependentNode.status) throw new Error('Persisted Worker trace dependency/status is incomplete.')
  const graphNode = persistedTrace.graphItem.content.nodes.find(node => node.key === dependentNode.key)
  expect(graphNode?.dependsOn).toEqual(dependentNode.dependencies.map(item => item.key))
  expect(dependency.label.trim().length).toBeGreaterThan(0)
  expect(dependentNode.readiness).not.toBe('unavailable')
  const fixture = await installTaskGraphFixture(page, persistedTrace)
  const sessionA = fixture.sessionA, revision = fixture.planRevision
  const expectedIdentity = graphIdentity(persistedTrace.graphItem)
  const ledgerResponsePromise = waitForPlanLedgerResponse(page, expectedIdentity, fixture, 'default', 'persisted trace')
  await page.goto(`/agent-preview?supervisor=1&locale=${locale}&sessionId=${sessionA}`)

  const plan = page.locator('[data-agent-task-graph-plan="true"]')
  const dependentRow = plan.locator('ol > li').nth(persistedLedger.nodes.indexOf(dependentNode))
  const renderedDependency = dependentRow.locator('ul > li').filter({ hasText: dependency.label })
  const sourcePreview = plan.locator('ol > li').first().locator('[data-task-graph-evidence="preview"]')
  await expect(plan).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => fixture.eventRequests.get(sessionA)?.length ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
  await expect(plan).toHaveAttribute('data-agent-task-graph-session', sessionA)
  await expect(plan).toHaveAttribute('data-agent-task-graph-revision', String(revision))
  if (persistedLedger.goal) await expect(plan.locator('[data-agent-task-graph-goal="true"]')).toHaveText(persistedLedger.goal)
  else await expect(plan.locator('[data-agent-task-graph-goal="true"]')).toHaveCount(0)
  for (const node of persistedLedger.nodes) await expect(plan).toContainText(node.goal)
  await expect(dependentRow.locator('div').first()).toContainText(planLedgerEnumLabel(locale, 'status', dependentNode.status))
  await expect(dependentRow).toContainText(taskGraphPlanLabel(locale, 'agent.taskGraph.readiness'))
  await expect(dependentRow).toContainText(planLedgerEnumLabel(locale, 'readiness', dependentNode.readiness))
  await expect(renderedDependency).toHaveCount(1)
  await expect(renderedDependency).toContainText(dependency.label)
  await expect(renderedDependency).toContainText(planLedgerEnumLabel(locale, 'status', dependency.status))
  await expect(plan).not.toContainText(GOAL_B)
  const interceptedResponse = await ledgerResponsePromise
  expect(interceptedResponse).toEqual({ identity: expectedIdentity, projection: persistedLedger })
  expect(fixture.planLedgers.get(`${sessionA}:${revision}`)).toEqual(interceptedResponse)
  expect(fixture.acceptedTaskLookups).toContainEqual({ sessionId: sessionA, taskIds: fixture.expectedTaskIds, identity: expectedIdentity })
  const interceptedLedger = interceptedResponse.projection
  expect(interceptedLedger.schemaVersion).toBe('agent-harness.v2.plan-ledger')
  expect(parsePlanLedger(JSON.stringify(interceptedLedger))).toEqual(persistedLedger)
  const serializedLedger = JSON.stringify(interceptedResponse)
  for (const secret of ['taskId', 'jobId', 'score', 'url', 'evidenceIds', 'finalText', 'task-graph.result-projection', 'fixture-job-restart', 'p3-process-restart-source-result']) {
    expect(serializedLedger).not.toContain(secret)
  }
  await expect(sourcePreview).toContainText(persistedLedger.nodes[0]!.evidencePreview!.summary)
  await expect(plan).not.toContainText('fixture-job-restart')
  await expect(plan).not.toContainText('p3-process-restart-source-result')
  expect(fixture.eventRequests.get(sessionA)?.slice(0, 2)).toEqual([null, persistedTrace.graphEvents.at(-1)!.sequence])

  const replacedChildTaskId = fixture.expectedTaskIds[1]!
  const mismatchedLookup = await page.evaluate(async ({ sessionId, taskIds, identity, replacedChildTaskId }) => {
    const query = new URLSearchParams()
    for (const taskId of taskIds) query.append('taskId', taskId === replacedChildTaskId ? 'mismatched-task-id' : taskId)
    query.set('graphItemId', identity.graphItemId)
    query.set('graphTurnId', identity.turnId)
    query.set('rootTaskId', identity.rootTaskId)
    query.set('graphRevision', String(identity.revision))
    const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/tasks?${query}`)
    const body = await response.json() as { tasks: Array<{ id: string }>; planLedger?: unknown }
    return { status: response.status, taskIds: body.tasks.map(task => task.id), planLedger: body.planLedger ?? null }
  }, { sessionId: sessionA, taskIds: fixture.expectedTaskIds, identity: expectedIdentity, replacedChildTaskId })
  expect(mismatchedLookup.status).toBe(200)
  expect(mismatchedLookup.planLedger).toBeNull()
  expect(mismatchedLookup.taskIds).toEqual([])

  const mismatchedLegacyLookup = await page.evaluate(async ({ sessionId, taskIds, identity, replacedChildTaskId }) => {
    const query = new URLSearchParams()
    for (const taskId of taskIds) query.append('taskId', taskId === replacedChildTaskId ? 'mismatched-task-id' : taskId)
    query.set('graphRevision', String(identity.revision))
    const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/tasks?${query}`)
    const body = await response.json() as { tasks: Array<{ id: string }>; planLedger?: unknown }
    return { status: response.status, taskIds: body.tasks.map(task => task.id), planLedger: body.planLedger ?? null }
  }, { sessionId: sessionA, taskIds: fixture.expectedTaskIds, identity: expectedIdentity, replacedChildTaskId })
  expect(mismatchedLegacyLookup.status).toBe(200)
  expect(mismatchedLegacyLookup.taskIds).toEqual([])
  expect(mismatchedLegacyLookup.planLedger).toBeNull()

  const mismatchedIdentityLookups = await page.evaluate(async ({ sessionId, taskIds, identity }) => {
    const selectors = ['graphItemId', 'graphTurnId', 'rootTaskId', 'graphRevision'] as const
    return Promise.all(selectors.map(async selector => {
      const query = new URLSearchParams()
      for (const taskId of taskIds) query.append('taskId', taskId)
      query.set('graphItemId', identity.graphItemId)
      query.set('graphTurnId', identity.turnId)
      query.set('rootTaskId', identity.rootTaskId)
      query.set('graphRevision', String(identity.revision))
      query.set(selector, selector === 'graphRevision' ? String(identity.revision + 1) : `mismatched-${query.get(selector)}`)
      const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/tasks?${query}`)
      const body = await response.json() as { tasks: Array<{ id: string }>; planLedger?: unknown }
      return { selector, status: response.status, taskIds: body.tasks.map(task => task.id), planLedger: body.planLedger ?? null }
    }))
  }, { sessionId: sessionA, taskIds: fixture.expectedTaskIds, identity: expectedIdentity })
  for (const lookup of mismatchedIdentityLookups) {
    expect(lookup.status).toBe(200)
    expect(lookup.taskIds).toEqual([])
    expect(lookup.planLedger).toBeNull()
  }

  const partialIdentityLookup = await page.evaluate(async ({ sessionId, taskIds, identity }) => {
    const query = new URLSearchParams()
    for (const taskId of taskIds) query.append('taskId', taskId)
    query.set('graphItemId', identity.graphItemId)
    query.set('graphTurnId', identity.turnId)
    query.set('rootTaskId', identity.rootTaskId)
    const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/tasks?${query}`)
    const body = await response.json() as { tasks?: unknown; planLedger?: unknown }
    return { status: response.status, planLedger: body.planLedger ?? null }
  }, { sessionId: sessionA, taskIds: fixture.expectedTaskIds, identity: expectedIdentity })
  expect(partialIdentityLookup.status).toBe(400)
  expect(partialIdentityLookup.planLedger).toBeNull()

  const missingTaskIdLookups = await page.evaluate(async ({ sessionId, identity }) => {
    const exact = new URLSearchParams({
      graphItemId: identity.graphItemId,
      graphTurnId: identity.turnId,
      rootTaskId: identity.rootTaskId,
      graphRevision: String(identity.revision),
    })
    const legacy = new URLSearchParams({ graphRevision: String(identity.revision) })
    return Promise.all([exact, legacy].map(async query => {
      const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/tasks?${query}`)
      const body = await response.json() as { error?: { code?: string }; planLedger?: unknown }
      return { status: response.status, code: body.error?.code, planLedger: body.planLedger ?? null }
    }))
  }, { sessionId: sessionA, identity: expectedIdentity })
  expect(missingTaskIdLookups).toEqual([
    { status: 400, code: 'task_graph_ids_required', planLedger: null },
    { status: 400, code: 'task_graph_ids_required', planLedger: null },
  ])

  const unversionedLookup = await page.evaluate(async ({ sessionId, taskIds }) => {
    const query = new URLSearchParams()
    for (const taskId of taskIds) query.append('taskId', taskId)
    const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/tasks?${query}`)
    const body = await response.json() as { planLedger?: unknown }
    return { status: response.status, planLedger: body.planLedger ?? null }
  }, { sessionId: sessionA, taskIds: fixture.expectedTaskIds })
  expect(unversionedLookup.status).toBe(200)
  expect(unversionedLookup.planLedger).toBeNull()

  const viewportWidth = await page.evaluate(() => window.innerWidth)
  if (viewportWidth <= 900) await page.getByRole('button', { name: locale === 'zh' ? '打开对话' : 'Open conversations', exact: true }).click()
  await page.locator('.agent-session-console').getByRole('button').filter({ hasText: GOAL_B }).first().click()

  const switchedPlan = page.locator('[data-agent-task-graph-plan="true"]')
  await expect.poll(() => fixture.eventRequests.get(SESSION_B)?.length ?? 0, { timeout: 10_000 }).toBeGreaterThan(0)
  await expect(switchedPlan).toHaveCount(0, { timeout: 10_000 })

  const sessionBIsolation = await page.evaluate(async ({ sessionId, taskIds, identity }) => {
    const base = `/api/agent/sessions/${encodeURIComponent(sessionId)}`
    const [timelineResponse, tasksResponse] = await Promise.all([
      fetch(`${base}/timeline`),
      fetch(`${base}/tasks`),
    ])
    const timeline = await timelineResponse.json() as { items: unknown[] }
    const tasks = await tasksResponse.json() as { tasks: Array<{ id: string }> }
    const query = new URLSearchParams()
    for (const taskId of taskIds) query.append('taskId', taskId)
    query.set('graphItemId', identity.graphItemId)
    query.set('graphTurnId', identity.turnId)
    query.set('rootTaskId', identity.rootTaskId)
    query.set('graphRevision', String(identity.revision))
    const lookupResponse = await fetch(`${base}/tasks?${query}`)
    const lookup = await lookupResponse.json() as { tasks: Array<{ id: string }>; planLedger?: unknown }
    return {
      timelineItems: timeline.items,
      taskIds: tasks.tasks.map(task => task.id),
      crossSessionLookup: {
        status: lookupResponse.status,
        taskIds: lookup.tasks.map(task => task.id),
        planLedger: lookup.planLedger ?? null,
      },
    }
  }, { sessionId: SESSION_B, taskIds: fixture.expectedTaskIds, identity: expectedIdentity })
  expect(sessionBIsolation).toEqual({
    timelineItems: [],
    taskIds: [],
    crossSessionLookup: { status: 200, taskIds: [], planLedger: null },
  })
  expect([...fixture.planLedgers.keys()].some(key => key.startsWith(`${SESSION_B}:`))).toBe(false)
  const nonNullPlanLedgers = [...fixture.planLedgers.values()].filter((response): response is PlanLedgerResponse => response !== null)
  expect(nonNullPlanLedgers.length).toBeGreaterThan(0)
  for (const response of nonNullPlanLedgers) {
    expect(response.identity.sessionId).toBe(sessionA)
    expect(fixture.traceGraphIdentities).toContainEqual(response.identity)
  }
  expect(fixture.forbiddenApiRequests).toEqual([])
  expect(fixture.externalRequests).toEqual([])
})

test('TaskGraph reconnect snapshot plus event tail matches the persisted trace plan projection', async ({ page }) => {
  const persistedTrace = requireProductionTraceArtifact()
  const persistedLedger = persistedTrace.planLedger
  const fixture = await installTaskGraphFixture(page, persistedTrace)
  const sessionA = fixture.sessionA, revision = fixture.planRevision
  fixture.setDeliveryMode('live')
  const initialIdentity = graphIdentity(persistedTrace.initialGraphItem)
  const initialResponsePromise = waitForPlanLedgerResponse(page, initialIdentity, fixture, 'live', 'live initial snapshot')
  await page.goto(`/agent-preview?supervisor=1&locale=en&sessionId=${sessionA}`)

  const plan = page.locator('[data-agent-task-graph-plan="true"]')
  const sourcePreview = plan.locator('ol > li').first().locator('[data-task-graph-evidence="preview"]')
  await expect(plan).toBeVisible({ timeout: 20_000 })
  const initialResponse = await initialResponsePromise
  await expect(sourcePreview).toContainText(persistedLedger.nodes[0]!.evidencePreview!.summary)
  expect(initialResponse.identity).toEqual(initialIdentity)
  expect(initialResponse.projection.revision).toBe(initialIdentity.revision)
  expect(fixture.planLedgers.get(`${sessionA}:${initialIdentity.revision}`)).toEqual(initialResponse)
  expect(fixture.acceptedTaskLookups).toContainEqual({
    sessionId: sessionA,
    taskIds: graphTaskIds(persistedTrace.initialGraphItem),
    identity: initialIdentity,
  })
  const liveIdentity = graphIdentity(persistedTrace.graphItem)
  const liveResponsePromise = waitForPlanLedgerResponse(page, liveIdentity, fixture, 'live', 'live event-tail ledger')
  fixture.releaseLiveDelta()
  await expect(plan).toHaveAttribute('data-agent-task-graph-revision', String(revision))
  await expect.poll(() => fixture.requestsByMode.get(`live:${sessionA}`)?.length ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
  const liveLedger = await liveResponsePromise
  expect(liveLedger).toEqual({ identity: liveIdentity, projection: persistedLedger })
  expect(fixture.planLedgers.get(`${sessionA}:${revision}`)).toEqual(liveLedger)
  await expect(sourcePreview).toContainText(persistedLedger.nodes[0]!.evidencePreview!.summary)
  const liveProjection = await readTaskGraphProjection(plan)
  expect(liveProjection.evidence[0]).toContain(persistedLedger.nodes[0]!.evidencePreview!.summary)
  expect(fixture.requestsByMode.get(`live:${sessionA}`)?.slice(0, 2)).toEqual([null, persistedTrace.graphEvents.at(-1)!.sequence])

  fixture.setDeliveryMode('snapshot-tail')
  const snapshotInitialResponsePromise = waitForPlanLedgerResponse(page, initialIdentity, fixture, 'snapshot-tail', 'snapshot initial response')
  await page.reload()
  await expect(plan).toBeVisible({ timeout: 20_000 })
  const snapshotInitialResponse = await snapshotInitialResponsePromise
  await expect(sourcePreview).toContainText(persistedLedger.nodes[0]!.evidencePreview!.summary)
  expect(snapshotInitialResponse?.identity).toEqual(initialIdentity)
  expect(fixture.planLedgers.get(`${sessionA}:${initialIdentity.revision}`)).toEqual(snapshotInitialResponse)
  fixture.releaseSnapshotClose()
  await expect.poll(() => fixture.requestsByMode.get(`snapshot-tail:${sessionA}`)?.length ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
  await expect(sourcePreview).toContainText(persistedLedger.nodes[0]!.evidencePreview!.summary)
  const resumedIdentity = graphIdentity(persistedTrace.graphItem)
  const resumedResponsePromise = waitForPlanLedgerResponse(page, resumedIdentity, fixture, 'snapshot-tail', 'resumed event-tail ledger')
  fixture.releaseSnapshotTail()
  await expect(plan).toHaveAttribute('data-agent-task-graph-revision', String(revision))
  await expect.poll(() => fixture.requestsByMode.get(`snapshot-tail:${sessionA}`)?.length ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(3)
  const resumedLedger = await resumedResponsePromise
  expect(resumedLedger).toEqual({ identity: resumedIdentity, projection: persistedLedger })
  expect(fixture.planLedgers.get(`${sessionA}:${revision}`)).toEqual(resumedLedger)
  await expect(sourcePreview).toContainText(persistedLedger.nodes[0]!.evidencePreview!.summary)
  const resumedProjection = await readTaskGraphProjection(plan)

  expect(fixture.requestsByMode.get(`snapshot-tail:${sessionA}`)?.slice(0, 3)).toEqual([null, '0', persistedTrace.graphEvents.at(-1)!.sequence])
  expect(resumedProjection).toEqual(liveProjection)
  await expect(plan).not.toContainText('fixture-job-restart')
  await expect(plan).not.toContainText('p3-process-restart-source-result')
  expect(fixture.forbiddenApiRequests).toEqual([])
  expect(fixture.externalRequests).toEqual([])
})
