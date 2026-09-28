import { expect, test } from './fixtures'
import type { Page, Route } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { parsePlanLedger, projectPlanLedger, type PlanLedger } from '@jobcopilot/agent-protocol'
import { redactStreamValue } from '../apps/web/src/lib/agent/session/stream-redaction'

const SCHEMA = 'agent-harness.v2'
const GRAPH_SCHEMA = 'agent-harness.v2.task-graph'
const TRACE_SCHEMA = 'agent-harness.v2.plan-ledger-trace'
const SESSION_B = 'task-graph-session-b'
const TURN_B = 'task-graph-turn-b'
const ROOT_B = 'task-graph-root-b'
const CHILD_B = 'task-graph-child-b'
const GOAL_B = 'Compare engineering teams in Amsterdam'
const NODE_GOAL_B = 'Review Amsterdam company profiles'
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

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
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
  const expectedTaskIds = [persistedTrace.rootTaskId, ...persistedGraphItem.content.nodes.map(node => node.taskId)]
  let deliveryMode: 'default' | 'live' | 'snapshot-tail' = 'default'
  let releaseLiveDelta!: () => void
  const liveDeltaGate = new Promise<void>(resolve => { releaseLiveDelta = resolve })
  let releaseSnapshotTail!: () => void
  const snapshotTailGate = new Promise<void>(resolve => { releaseSnapshotTail = resolve })
  let releaseSnapshotClose!: () => void
  const snapshotCloseGate = new Promise<void>(resolve => { releaseSnapshotClose = resolve })
  const fixture = {
    sessionA: SESSION_A,
    goalA: GOAL_A,
    planRevision: PLAN_REVISION,
    persistedLedger,
    expectedTaskIds,
    eventRequests: new Map<string, Array<string | null>>(),
    requestsByMode: new Map<string, Array<string | null>>(),
    taskRequestsByMode: new Map<string, number>(),
    planLedgers: new Map<string, PlanLedger | null>(),
    acceptedTaskLookups: [] as Array<{ sessionId: string; taskIds: string[]; revision: number }>,
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
        { id: SESSION_B, goal: GOAL_B, status: 'running', updatedAt: TIME, memorySummary: 'Persisted plan B.' },
      ],
      lastOpenedSessionId: SESSION_A,
    })

    const parts = pathname.split('/').filter(Boolean)
    if (parts[0] === 'api' && parts[1] === 'agent' && parts[2] === 'sessions' && parts.length >= 4) {
      const sessionId = parts[3]!
      const turnId = sessionId === SESSION_A ? persistedGraphItem.turnId : TURN_B
      const rootTaskId = sessionId === SESSION_A ? persistedTrace.rootTaskId : ROOT_B
      const childTaskId = sessionId === SESSION_A ? persistedGraphItem.content.nodes[0]!.taskId : CHILD_B
      const goal = sessionId === SESSION_A ? GOAL_A : GOAL_B
      const nodeGoal = NODE_GOAL_B
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
        const graph = sessionId === SESSION_A
          ? persistedTrace.initialGraphItem
          : taskGraphItem(SESSION_B, TURN_B, ROOT_B, 'task-graph-item-b', 'amsterdam-companies', CHILD_B, NODE_GOAL_B, 9)
        return json(route, { items: [graph], agenda: null, page: { hasMore: false, nextCursor: null } })
      }
      if (resource === 'tasks') {
        const taskModeKey = `${deliveryMode}:${sessionId}`
        const requestedTaskIds = url.searchParams.getAll('taskId')
        const isTaskLookup = requestedTaskIds.length > 0
        const taskRequestCount = fixture.taskRequestsByMode.get(taskModeKey) ?? 0
        if (isTaskLookup) fixture.taskRequestsByMode.set(taskModeKey, taskRequestCount + 1)
        const requestedRevision = url.searchParams.get('graphRevision')
        const revision = requestedRevision === null ? persistedGraphItem.revision : Number(requestedRevision)
        if (sessionId === SESSION_A) {
          const invalidTaskIds = requestedTaskIds.length > 9
            || new Set(requestedTaskIds).size !== requestedTaskIds.length
            || requestedTaskIds.some(taskId => taskId.length < 1 || taskId.length > 128 || taskId.trim() !== taskId)
          if (isTaskLookup && invalidTaskIds) {
            return json(route, { error: { code: 'invalid_task_ids', message: 'taskId values must be unique and bounded', details: {} } }, 400)
          }
          if (isTaskLookup) fixture.acceptedTaskLookups.push({ sessionId, taskIds: requestedTaskIds, revision })
          const tasks = persistedTrace.tasks.filter(task => task.sessionId === sessionId
            && (!isTaskLookup || requestedTaskIds.includes(task.id)))
          const revisionMatches = requestedRevision === null || requestedRevision === String(persistedGraphItem.revision)
          const parsedLedger = isTaskLookup && sessionId === persistedLedger.sessionId && revisionMatches
            ? projectPlanLedger({
              sessionId,
              revision: persistedGraphItem.revision,
              rootTaskId: persistedGraphItem.taskId,
              graph: persistedGraphItem.content,
              tasks,
            })
            : null
          if (isTaskLookup) fixture.planLedgers.set(`${sessionId}:${revision}`, parsedLedger)
          return json(route, { tasks, ...(parsedLedger ? { planLedger: parsedLedger } : {}), page: { hasMore: false, nextCursor: null } })
        }
        const tasks = [
          { id: rootTaskId, sessionId, turnId, parentTaskId: null, role: 'orchestrator', taskType: 'root', status: 'running', goal, hasResult: false },
          { id: childTaskId, sessionId, turnId, parentTaskId: rootTaskId, role: 'scout', taskType: 'research',
            status: 'queued', goal: nodeGoal, hasResult: false },
        ]
        return json(route, { tasks, page: { hasMore: false, nextCursor: null } })
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

function jsonSse(route: Route, events: readonly PersistedGraphEvent[]) {
  return route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: events.map(event => {
      const redactedEvent = { ...event, payload: redactStreamValue(event.payload) }
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

test('Plan Ledger restores the same persisted trace session after SSE reconnect without leaking across sessions', async ({ page }) => {
  const persistedTrace = requireProductionTraceArtifact()
  const persistedLedger = persistedTrace.planLedger
  const fixture = await installTaskGraphFixture(page, persistedTrace)
  const sessionA = fixture.sessionA, revision = fixture.planRevision
  await page.goto(`/agent-preview?supervisor=1&locale=en&sessionId=${sessionA}`)

  const plan = page.locator('[data-agent-task-graph-plan="true"]')
  await expect(plan).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => fixture.eventRequests.get(sessionA)?.length ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
  await expect(plan).toHaveAttribute('data-agent-task-graph-session', sessionA)
  await expect(plan).toHaveAttribute('data-agent-task-graph-revision', String(revision))
  if (persistedLedger.goal) await expect(plan.locator('[data-agent-task-graph-goal="true"]')).toHaveText(persistedLedger.goal)
  else await expect(plan.locator('[data-agent-task-graph-goal="true"]')).toHaveCount(0)
  for (const node of persistedLedger.nodes) await expect(plan).toContainText(node.goal)
  await expect(plan).not.toContainText(GOAL_B)
  await expect(plan).not.toContainText(NODE_GOAL_B)
  const interceptedLedger = fixture.planLedgers.get(`${sessionA}:${revision}`)
  expect(interceptedLedger).toEqual(persistedLedger)
  expect(fixture.acceptedTaskLookups).toContainEqual({ sessionId: sessionA, taskIds: fixture.expectedTaskIds, revision })
  expect(interceptedLedger?.schemaVersion).toBe('agent-harness.v2.plan-ledger')
  expect(parsePlanLedger(JSON.stringify(interceptedLedger))).toEqual(persistedLedger)
  const serializedLedger = JSON.stringify(interceptedLedger)
  for (const secret of ['taskId', 'jobId', 'score', 'url', 'evidenceIds', 'finalText', 'task-graph.result-projection', 'fixture-job-restart', 'p3-process-restart-source-result']) {
    expect(serializedLedger).not.toContain(secret)
  }
  await expect(plan.locator('[data-task-graph-evidence="preview"]')).toContainText(persistedLedger.nodes[0]!.evidencePreview!.summary)
  await expect(plan).not.toContainText('fixture-job-restart')
  await expect(plan).not.toContainText('p3-process-restart-source-result')
  expect(fixture.eventRequests.get(sessionA)?.slice(0, 2)).toEqual([null, persistedTrace.graphEvents.at(-1)!.sequence])

  const replacedChildTaskId = fixture.expectedTaskIds[1]!
  const replacedNodeKey = persistedTrace.graphItem.content.nodes.find(node => node.taskId === replacedChildTaskId)?.key
  expect(replacedNodeKey).toBeDefined()
  const mismatchedLookup = await page.evaluate(async ({ sessionId, taskIds, revision, replacedChildTaskId }) => {
    const query = new URLSearchParams()
    for (const taskId of taskIds) query.append('taskId', taskId === replacedChildTaskId ? 'mismatched-task-id' : taskId)
    query.set('graphRevision', String(revision))
    const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/tasks?${query}`)
    const body = await response.json() as { tasks: Array<{ id: string }>; planLedger?: unknown }
    return { status: response.status, taskIds: body.tasks.map(task => task.id), planLedger: body.planLedger ?? null }
  }, { sessionId: sessionA, taskIds: fixture.expectedTaskIds, revision, replacedChildTaskId })
  expect(mismatchedLookup.status).toBe(200)
  expect(mismatchedLookup.planLedger).not.toBeNull()
  expect(mismatchedLookup.taskIds).toEqual(persistedTrace.tasks
    .filter(task => task.id !== replacedChildTaskId).map(task => task.id))
  const partialLedger = parsePlanLedger(mismatchedLookup.planLedger)
  expect(partialLedger).toMatchObject({ sessionId: sessionA, revision })
  expect(partialLedger?.nodes.find(node => node.key === replacedNodeKey)).toMatchObject({
    status: null,
    resultAvailable: false,
    evidencePreview: null,
  })

  const unversionedLookup = await page.evaluate(async ({ sessionId, taskIds }) => {
    const query = new URLSearchParams()
    for (const taskId of taskIds) query.append('taskId', taskId)
    const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/tasks?${query}`)
    const body = await response.json() as { planLedger?: unknown }
    return { status: response.status, planLedger: body.planLedger ?? null }
  }, { sessionId: sessionA, taskIds: fixture.expectedTaskIds })
  expect(unversionedLookup.status).toBe(200)
  expect(parsePlanLedger(unversionedLookup.planLedger)).toEqual(persistedLedger)

  const viewportWidth = await page.evaluate(() => window.innerWidth)
  if (viewportWidth <= 900) await page.getByRole('button', { name: /conversations/i }).first().click()
  await page.locator('.agent-session-console').getByRole('button').filter({ hasText: GOAL_B }).first().click()

  const switchedPlan = page.locator('[data-agent-task-graph-plan="true"]')
  await expect(switchedPlan).toBeVisible({ timeout: 10_000 })
  await expect(switchedPlan).toHaveAttribute('data-agent-task-graph-session', SESSION_B)
  await expect(switchedPlan).toHaveAttribute('data-agent-task-graph-revision', '9')
  await expect(switchedPlan.locator('[data-agent-task-graph-goal="true"]')).toHaveText(GOAL_B)
  await expect(switchedPlan).toContainText(NODE_GOAL_B)
  await expect(switchedPlan).not.toContainText(fixture.goalA)
  for (const node of persistedLedger.nodes) await expect(switchedPlan).not.toContainText(node.goal)
  await expect(switchedPlan.locator('[data-task-graph-evidence]')).toHaveCount(0)
  expect(fixture.forbiddenApiRequests).toEqual([])
  expect(fixture.externalRequests).toEqual([])
})

test('TaskGraph reconnect snapshot plus event tail matches the persisted trace plan projection', async ({ page }) => {
  const persistedTrace = requireProductionTraceArtifact()
  const persistedLedger = persistedTrace.planLedger
  const fixture = await installTaskGraphFixture(page, persistedTrace)
  const sessionA = fixture.sessionA, revision = fixture.planRevision
  fixture.setDeliveryMode('live')
  await page.goto(`/agent-preview?supervisor=1&locale=en&sessionId=${sessionA}`)

  const plan = page.locator('[data-agent-task-graph-plan="true"]')
  await expect(plan).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => fixture.taskRequestsByMode.get(`live:${sessionA}`) ?? 0, { timeout: 10_000 }).toBe(1)
  await expect(plan.locator('[data-task-graph-evidence="preview"]')).toContainText(persistedLedger.nodes[0]!.evidencePreview!.summary)
  expect(fixture.planLedgers.get(`${sessionA}:${persistedTrace.initialGraphItem.revision}`)).toBeNull()
  fixture.releaseLiveDelta()
  await expect(plan).toHaveAttribute('data-agent-task-graph-revision', String(revision))
  await expect.poll(() => fixture.requestsByMode.get(`live:${sessionA}`)?.length ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
  await expect.poll(() => fixture.taskRequestsByMode.get(`live:${sessionA}`) ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
  const liveLedger = fixture.planLedgers.get(`${sessionA}:${revision}`)
  expect(liveLedger).toEqual(persistedLedger)
  await expect(plan.locator('[data-task-graph-evidence="preview"]')).toContainText(persistedLedger.nodes[0]!.evidencePreview!.summary)
  const liveProjection = await readTaskGraphProjection(plan)
  expect(liveProjection.evidence[0]).toContain(persistedLedger.nodes[0]!.evidencePreview!.summary)
  expect(fixture.requestsByMode.get(`live:${sessionA}`)?.slice(0, 2)).toEqual([null, persistedTrace.graphEvents.at(-1)!.sequence])

  fixture.setDeliveryMode('snapshot-tail')
  await page.reload()
  await expect(plan).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => fixture.taskRequestsByMode.get(`snapshot-tail:${sessionA}`) ?? 0, { timeout: 10_000 }).toBe(1)
  await expect(plan.locator('[data-task-graph-evidence="preview"]')).toContainText(persistedLedger.nodes[0]!.evidencePreview!.summary)
  expect(fixture.planLedgers.get(`${sessionA}:${persistedTrace.initialGraphItem.revision}`)).toBeNull()
  fixture.releaseSnapshotClose()
  await expect.poll(() => fixture.requestsByMode.get(`snapshot-tail:${sessionA}`)?.length ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
  expect(fixture.taskRequestsByMode.get(`snapshot-tail:${sessionA}`)).toBe(1)
  await expect(plan.locator('[data-task-graph-evidence="preview"]')).toContainText(persistedLedger.nodes[0]!.evidencePreview!.summary)
  fixture.releaseSnapshotTail()
  await expect(plan).toHaveAttribute('data-agent-task-graph-revision', String(revision))
  await expect.poll(() => fixture.requestsByMode.get(`snapshot-tail:${sessionA}`)?.length ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(3)
  await expect.poll(() => fixture.taskRequestsByMode.get(`snapshot-tail:${sessionA}`) ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(3)
  const resumedLedger = fixture.planLedgers.get(`${sessionA}:${revision}`)
  expect(resumedLedger).toEqual(persistedLedger)
  await expect(plan.locator('[data-task-graph-evidence="preview"]')).toContainText(persistedLedger.nodes[0]!.evidencePreview!.summary)
  const resumedProjection = await readTaskGraphProjection(plan)

  expect(fixture.requestsByMode.get(`snapshot-tail:${sessionA}`)?.slice(0, 3)).toEqual([null, '0', persistedTrace.graphEvents.at(-1)!.sequence])
  expect(resumedProjection).toEqual(liveProjection)
  await expect(plan).not.toContainText('fixture-job-restart')
  await expect(plan).not.toContainText('p3-process-restart-source-result')
  expect(fixture.forbiddenApiRequests).toEqual([])
  expect(fixture.externalRequests).toEqual([])
})
