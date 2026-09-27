import { expect, test } from './fixtures'
import type { Page, Route } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { parsePlanLedger, type PlanLedger } from '@jobcopilot/agent-protocol'

const SCHEMA = 'agent-harness.v2'
const GRAPH_SCHEMA = 'agent-harness.v2.task-graph'
const SESSION_B = 'task-graph-session-b'
const TURN_A = 'task-graph-turn-a'
const TURN_B = 'task-graph-turn-b'
const ROOT_A = 'task-graph-root-a'
const ROOT_B = 'task-graph-root-b'
const CHILD_A = 'task-graph-child-a'
const CHILD_B = 'task-graph-child-b'
const GOAL_A = 'Find senior backend roles in Dublin'
const GOAL_B = 'Compare engineering teams in Amsterdam'
const NODE_GOAL_B = 'Review Amsterdam company profiles'
const PRIVATE_RESULT_B = 'PRIVATE_RESULT_B_MUST_NOT_RENDER'
const TIME = '2026-09-24T10:00:00.000Z'
// The focused CI browser step supplies the exact safe JSON emitted after the Worker/PG trace asserts it.
const traceArtifactPath = process.env.AGENT_PLAN_LEDGER_TRACE_ARTIFACT_PATH
const traceLedger = traceArtifactPath ? parsePlanLedger(readFileSync(traceArtifactPath, 'utf8')) : null
if (traceArtifactPath && (!traceLedger || traceLedger.revision < 2 || traceLedger.nodes.length < 2)) {
  throw new Error('The Worker process-restart trace artifact is missing or invalid.')
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

async function installTaskGraphFixture(page: Page, persistedLedger: PlanLedger) {
  const SESSION_A = persistedLedger.sessionId
  const PLAN_REVISION = persistedLedger.revision
  const INITIAL_REVISION = PLAN_REVISION - 1
  const NODE_GOAL_A = persistedLedger.nodes[0]!.goal
  let deliveryMode: 'default' | 'live' | 'snapshot-tail' = 'default'
  let releaseLiveDelta!: () => void
  const liveDeltaGate = new Promise<void>(resolve => { releaseLiveDelta = resolve })
  let releaseSnapshotTail!: () => void
  const snapshotTailGate = new Promise<void>(resolve => { releaseSnapshotTail = resolve })
  let releaseSnapshotWakeup!: () => void
  const snapshotWakeupGate = new Promise<void>(resolve => { releaseSnapshotWakeup = resolve })
  const fixture = {
    sessionA: SESSION_A,
    planRevision: PLAN_REVISION,
    persistedLedger,
    eventRequests: new Map<string, Array<string | null>>(),
    requestsByMode: new Map<string, Array<string | null>>(),
    taskRequestsByMode: new Map<string, number>(),
    planLedgers: new Map<string, PlanLedger | null>(),
    forbiddenApiRequests: [] as string[],
    externalRequests: [] as string[],
    setDeliveryMode(mode: 'live' | 'snapshot-tail') {
      deliveryMode = mode
    },
    releaseLiveDelta() { releaseLiveDelta() },
    releaseSnapshotWakeup() { releaseSnapshotWakeup() },
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
      const turnId = sessionId === SESSION_A ? TURN_A : TURN_B
      const rootTaskId = sessionId === SESSION_A ? ROOT_A : ROOT_B
      const childTaskId = sessionId === SESSION_A ? CHILD_A : CHILD_B
      const goal = sessionId === SESSION_A ? GOAL_A : GOAL_B
      const nodeGoal = sessionId === SESSION_A ? NODE_GOAL_A : NODE_GOAL_B
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
          const nextItem = taskGraphItem(SESSION_A, TURN_A, ROOT_A, 'task-graph-item-a', 'dublin-employers', CHILD_A, NODE_GOAL_A, PLAN_REVISION)
          const event = taskGraphDelta('live-task-graph-a', '1', 'delta', nextItem, INITIAL_REVISION)
          return jsonSse(route, event)
        }
        if (sessionId === SESSION_A && deliveryMode === 'snapshot-tail' && modeRequests.length === 1) {
          await snapshotWakeupGate
          return jsonSse(route, {
            schemaVersion: SCHEMA,
            id: 'task-graph-reconnect-cursor-a',
            sessionId: SESSION_A,
            turnId: TURN_A,
            itemId: null,
          taskId: ROOT_A,
            type: 'turn.wakeup',
            actor: 'system',
            sequence: '1',
            payload: { wakeReason: 'resume' },
            createdAt: '2026-09-24T10:00:01.000Z',
          })
        }
        if (sessionId === SESSION_A && deliveryMode === 'snapshot-tail' && modeRequests.length === 2) {
          await snapshotTailGate
          const nextItem = taskGraphItem(SESSION_A, TURN_A, ROOT_A, 'task-graph-item-a', 'dublin-employers', CHILD_A, NODE_GOAL_A, PLAN_REVISION)
          const event = taskGraphDelta('replayed-task-graph-a', '2', 'snapshot', nextItem, INITIAL_REVISION)
          return jsonSse(route, event)
        }
        if (sessionId === SESSION_A && requests.length === 1) {
          const nextItem = taskGraphItem(SESSION_A, TURN_A, ROOT_A, 'task-graph-item-a', 'dublin-employers', CHILD_A, NODE_GOAL_A, PLAN_REVISION)
          const event = taskGraphDelta('task-graph-snapshot-a-revision-2', '1', 'snapshot', nextItem, INITIAL_REVISION)
          return jsonSse(route, event)
        }
        // The finite fixture stream closes after each response; the real client must reconnect from its last sequence.
        await new Promise(resolve => setTimeout(resolve, 900))
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': task graph fixture stream\n\n' })
      }
      if (resource === 'timeline') {
        const graph = sessionId === SESSION_A
          ? taskGraphItem(SESSION_A, TURN_A, ROOT_A, 'task-graph-item-a', 'dublin-employers', CHILD_A, NODE_GOAL_A, INITIAL_REVISION)
          : taskGraphItem(SESSION_B, TURN_B, ROOT_B, 'task-graph-item-b', 'amsterdam-companies', CHILD_B, NODE_GOAL_B, 9)
        return json(route, { items: [graph], approvalEvents: [] })
      }
      if (resource === 'tasks') {
        const taskModeKey = `${deliveryMode}:${sessionId}`
        const isTaskLookup = url.searchParams.has('taskId')
        const taskRequestCount = fixture.taskRequestsByMode.get(taskModeKey) ?? 0
        if (isTaskLookup) fixture.taskRequestsByMode.set(taskModeKey, taskRequestCount + 1)
        const revision = Number(url.searchParams.get('graphRevision'))
        const tasks = [
          { id: rootTaskId, sessionId, turnId, parentTaskId: null, role: 'orchestrator', taskType: 'root', status: 'running', goal, hasResult: false },
          { id: childTaskId, sessionId, turnId, parentTaskId: rootTaskId, role: 'scout', taskType: 'research',
            status: sessionId === SESSION_A ? 'passed' : 'queued', goal: nodeGoal, hasResult: sessionId === SESSION_A },
        ]
        const parsedLedger = isTaskLookup && sessionId === SESSION_A && revision === PLAN_REVISION ? persistedLedger : null
        if (isTaskLookup) fixture.planLedgers.set(`${sessionId}:${revision}`, parsedLedger)
        return json(route, { tasks, ...(parsedLedger ? { planLedger: parsedLedger } : {}) })
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

function taskGraphDelta(id: string, sequence: string, kind: 'delta' | 'snapshot', item: ReturnType<typeof taskGraphItem>, baseRevision: number) {
  return {
    schemaVersion: SCHEMA,
    id,
    sessionId: item.sessionId,
    turnId: item.turnId,
    itemId: item.id,
    taskId: item.taskId,
    type: 'item.delta',
    actor: 'system',
    sequence,
    kind,
    baseRevision,
    revision: item.revision,
    payload: { revision: item.revision, item },
    createdAt: '2026-09-24T10:00:01.000Z',
  }
}

function jsonSse(route: Route, event: unknown) {
  return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: timeline\ndata: ${JSON.stringify(event)}\n\n` })
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

function requireProductionTraceLedger() {
  if (!traceLedger) test.skip(true, 'Requires the disposable PostgreSQL Worker process-restart trace artifact.')
  return traceLedger!
}

test('Plan Ledger restores the same persisted trace session after SSE reconnect without leaking across sessions', async ({ page }) => {
  const persistedTrace = requireProductionTraceLedger()
  const fixture = await installTaskGraphFixture(page, persistedTrace)
  const sessionA = fixture.sessionA, revision = fixture.planRevision
  const nodeGoalA = persistedTrace.nodes[0]!.goal
  await page.goto(`/agent-preview?supervisor=1&locale=en&sessionId=${sessionA}`)

  const plan = page.locator('[data-agent-task-graph-plan="true"]')
  await expect(plan).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => fixture.eventRequests.get(sessionA)?.length ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
  await expect(plan).toHaveAttribute('data-agent-task-graph-session', sessionA)
  await expect(plan).toHaveAttribute('data-agent-task-graph-revision', String(revision))
  if (persistedTrace.goal) await expect(plan.locator('[data-agent-task-graph-goal="true"]')).toHaveText(persistedTrace.goal)
  else await expect(plan.locator('[data-agent-task-graph-goal="true"]')).toHaveCount(0)
  for (const node of persistedTrace.nodes) await expect(plan).toContainText(node.goal)
  const interceptedLedger = fixture.planLedgers.get(`${sessionA}:${revision}`)
  expect(interceptedLedger).toEqual(persistedTrace)
  expect(interceptedLedger?.schemaVersion).toBe('agent-harness.v2.plan-ledger')
  expect(parsePlanLedger(JSON.stringify(interceptedLedger))).toEqual(persistedTrace)
  const serializedLedger = JSON.stringify(interceptedLedger)
  for (const secret of ['taskId', 'jobId', 'score', 'url', 'evidenceIds', 'finalText', 'task-graph.result-projection', 'fixture-job-restart', 'p3-process-restart-source-result']) {
    expect(serializedLedger).not.toContain(secret)
  }
  await expect(plan.locator('[data-task-graph-evidence="preview"]')).toContainText(persistedTrace.nodes[0]!.evidencePreview!.summary)
  await expect(plan).not.toContainText('fixture-job-restart')
  await expect(plan).not.toContainText('p3-process-restart-source-result')
  expect(fixture.eventRequests.get(sessionA)?.slice(0, 2)).toEqual([null, '1'])

  const viewportWidth = await page.evaluate(() => window.innerWidth)
  if (viewportWidth <= 900) await page.getByRole('button', { name: /conversations/i }).first().click()
  await page.locator('.agent-session-console').getByRole('button').filter({ hasText: GOAL_B }).first().click()

  const switchedPlan = page.locator('[data-agent-task-graph-plan="true"]')
  await expect(switchedPlan).toBeVisible({ timeout: 10_000 })
  await expect(switchedPlan).toHaveAttribute('data-agent-task-graph-session', SESSION_B)
  await expect(switchedPlan).toHaveAttribute('data-agent-task-graph-revision', '9')
  await expect(switchedPlan.locator('[data-agent-task-graph-goal="true"]')).toHaveText(GOAL_B)
  await expect(switchedPlan).toContainText(NODE_GOAL_B)
  await expect(switchedPlan).not.toContainText(GOAL_A)
  await expect(switchedPlan).not.toContainText(nodeGoalA)
  await expect(switchedPlan.locator('[data-task-graph-evidence]')).toHaveCount(0)
  await expect(switchedPlan).not.toContainText(PRIVATE_RESULT_B)
  for (const node of persistedTrace.nodes) await expect(switchedPlan).not.toContainText(node.goal)
  expect(fixture.forbiddenApiRequests).toEqual([])
  expect(fixture.externalRequests).toEqual([])
})

test('TaskGraph reconnect snapshot plus event tail matches the persisted trace plan projection', async ({ page }) => {
  const persistedTrace = requireProductionTraceLedger()
  const fixture = await installTaskGraphFixture(page, persistedTrace)
  const sessionA = fixture.sessionA, revision = fixture.planRevision
  fixture.setDeliveryMode('live')
  await page.goto(`/agent-preview?supervisor=1&locale=en&sessionId=${sessionA}`)

  const plan = page.locator('[data-agent-task-graph-plan="true"]')
  await expect(plan).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => fixture.taskRequestsByMode.get(`live:${sessionA}`) ?? 0, { timeout: 10_000 }).toBe(1)
  await expect(plan.locator('[data-task-graph-evidence="preview"]')).toHaveCount(0)
  fixture.releaseLiveDelta()
  await expect(plan).toHaveAttribute('data-agent-task-graph-revision', String(revision))
  await expect.poll(() => fixture.requestsByMode.get(`live:${sessionA}`)?.length ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
  await expect.poll(() => fixture.taskRequestsByMode.get(`live:${sessionA}`) ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
  const liveLedger = fixture.planLedgers.get(`${sessionA}:${revision}`)
  expect(liveLedger).toEqual(persistedTrace)
  await expect(plan.locator('[data-task-graph-evidence="preview"]')).toContainText(persistedTrace.nodes[0]!.evidencePreview!.summary)
  const liveProjection = await readTaskGraphProjection(plan)
  expect(liveProjection.evidence[0]).toContain(persistedTrace.nodes[0]!.evidencePreview!.summary)
  expect(fixture.requestsByMode.get(`live:${sessionA}`)?.slice(0, 2)).toEqual([null, '1'])

  fixture.setDeliveryMode('snapshot-tail')
  await page.reload()
  await expect(plan).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => fixture.taskRequestsByMode.get(`snapshot-tail:${sessionA}`) ?? 0, { timeout: 10_000 }).toBe(1)
  await expect(plan.locator('[data-task-graph-evidence="preview"]')).toHaveCount(0)
  fixture.releaseSnapshotWakeup()
  await expect.poll(() => fixture.taskRequestsByMode.get(`snapshot-tail:${sessionA}`) ?? 0, { timeout: 10_000 }).toBe(2)
  await expect(plan.locator('[data-task-graph-evidence="preview"]')).toHaveCount(0)
  fixture.releaseSnapshotTail()
  await expect(plan).toHaveAttribute('data-agent-task-graph-revision', String(revision))
  await expect.poll(() => fixture.requestsByMode.get(`snapshot-tail:${sessionA}`)?.length ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(3)
  await expect.poll(() => fixture.taskRequestsByMode.get(`snapshot-tail:${sessionA}`) ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(3)
  const resumedLedger = fixture.planLedgers.get(`${sessionA}:${revision}`)
  expect(resumedLedger).toEqual(persistedTrace)
  await expect(plan.locator('[data-task-graph-evidence="preview"]')).toContainText(persistedTrace.nodes[0]!.evidencePreview!.summary)
  const resumedProjection = await readTaskGraphProjection(plan)

  expect(fixture.requestsByMode.get(`snapshot-tail:${sessionA}`)?.slice(0, 3)).toEqual([null, '1', '2'])
  expect(resumedProjection).toEqual(liveProjection)
  await expect(plan).not.toContainText('fixture-job-restart')
  await expect(plan).not.toContainText('p3-process-restart-source-result')
  expect(fixture.forbiddenApiRequests).toEqual([])
  expect(fixture.externalRequests).toEqual([])
})
