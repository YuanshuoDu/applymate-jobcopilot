import { expect, test } from './fixtures'
import type { Page, Route } from '@playwright/test'
import path from 'node:path'

const SCHEMA = 'agent-harness.v2'
const SESSION_A = 'fixture-session-a'
const SESSION_B = 'fixture-session-b'
const TURN_A = 'fixture-turn-a'
const TURN_B = 'fixture-turn-b'
const STEP_A = 'fixture-step-a'
const ITEM_A = 'fixture-item-a'
const ITEM_B = 'fixture-item-b'
const CHILD_TASK_A = 'task-child-a'
const APPROVAL_ID = 'fixture-approval-a'
const SELECTED_JOB_TURN_A = 'fixture-preparation-turn'
const SELECTED_JOB_TURN_B = 'fixture-preparation-turn-next'
const ORDINARY_CHAT_TURN = 'fixture-ordinary-chat-turn'
const SELECTED_JOB_TEXT = 'Prepare a cover letter draft for the selected job.'

const times = {
  created: '2026-09-07T10:00:00.000Z',
  updated: '2026-09-07T10:01:00.000Z',
}

function json(route: Route, data: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) })
}

function item(sessionId: string, turnId: string, id: string, text: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: SCHEMA,
    id,
    sessionId,
    turnId,
    stepId: sessionId === SESSION_A ? STEP_A : null,
    taskId: null,
    type: 'agent_message',
    status: 'queued',
    phase: 'commentary',
    revision: 1,
    content: { text },
    startedAt: times.created,
    completedAt: null,
    createdAt: times.created,
    updatedAt: times.updated,
    sequence: null,
    ...overrides,
  }
}

function turn(sessionId: string, turnId: string, status: string, activeStepId: string | null) {
  return {
    id: turnId,
    sessionId,
    source: 'message',
    goal: sessionId === SESSION_A ? 'Inspect saved roles' : 'B session evidence',
    status,
    revision: 1,
    activeStepId,
    finalItemId: status === 'completed' ? (sessionId === SESSION_A ? ITEM_A : ITEM_B) : null,
    createdAt: times.created,
    updatedAt: times.updated,
    completedAt: status === 'completed' ? times.updated : null,
  }
}

function event(sessionId: string, turnId: string, id: string, sequence: string, type: string, payload: unknown, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: SCHEMA,
    id,
    sessionId,
    turnId,
    itemId: ITEM_A,
    taskId: null,
    type,
    actor: 'fixture-model',
    sequence,
    payload,
    ...extra,
  }
}

async function installSupervisorFixture(page: Page, selectedJobEnabled = false, selectedJobTurnGateRegression = false, selectedJobPendingWriter = false, selectedJobHistoricalArtifact = false) {
  const fixture = {
    aStreamCount: 0,
    eventSequence: 0,
    lifecycleStarted: false,
    replayArmed: false,
    replayRequestsAfterSequence: [] as Array<string | null>,
    replaySequence: null as string | null,
    replayEvent: null as ReturnType<typeof event> | null,
    replayDuplicateSent: false,
    childTaskStarted: false,
    childTaskCompleted: false,
    taskLifecycleConnections: [] as number[],
    tasksQueryCount: 0,
    tasksQueryCountAtStartEvent: 0,
    tasksQueryCountAtCompletedEvent: 0,
    retryTurnStatus: null as string | null,
    retryRequests: [] as Array<{
      sessionId: string
      turnId: string
      body: Record<string, unknown>
      idempotencyKey: string | undefined
    }>,
    approvalDecisions: [] as Array<{
      sessionId: string
      approvalId: string
      body: Record<string, unknown>
      idempotencyKey: string | undefined
    }>,
    selectedJobStarted: selectedJobTurnGateRegression,
    selectedJobRequests: [] as Array<Record<string, unknown>>,
    selectedJobDetailRequests: [] as string[],
    selectedJobListResponses: [] as string[][],
    selectedJobDisconnectArmed: false,
    selectedJobStreamSequences: [] as Array<string | null>,
    selectedJobReconnectSequence: null as string | null,
    selectedJobGraphReleaseArmed: false,
    selectedJobGraphEventSent: false,
    ordinaryChatRequests: [] as Array<Record<string, unknown>>,
    ordinaryChatEventSent: false,
  }
  const stageStatus = () => {
    if (fixture.retryTurnStatus) return fixture.retryTurnStatus
    if (fixture.aStreamCount >= 5) return 'completed'
    return ['queued', 'in_progress', 'waiting_for_user'][Math.min(fixture.aStreamCount, 2)]
  }
  const childStatus = () => fixture.childTaskCompleted ? 'completed' : fixture.childTaskStarted ? 'running' : 'queued'
  const nextEventSequence = () => {
    fixture.eventSequence += 1
    return String(fixture.eventSequence)
  }

  await page.route('**/api/auth/session', route => json(route, {
    user: { id: 'agent-supervisor-fixture', email: 'fixture@applymate.local', name: 'Fixture' },
    expires: '2099-01-01T00:00:00.000Z',
  }))
  await page.route('**/api/me', route => json(route, { id: 'agent-supervisor-fixture', email: 'fixture@applymate.local', name: 'Fixture', plan: 'pro', onboardedAt: times.created }))
  await page.route('**/api/jobs**', route => {
    const url = new URL(route.request().url())
    if (selectedJobPendingWriter && fixture.selectedJobStarted && route.request().method() === 'GET' && url.pathname === '/api/jobs/fixture-selected-job') {
      fixture.selectedJobDetailRequests.push(url.pathname)
      return json(route, { id: 'fixture-selected-job', company: 'Fixture Systems', role: 'Systems Engineer', status: 'saved', description: 'Private detail fixture.' })
    }
    const hideRestoredJobFromList = selectedJobPendingWriter && fixture.selectedJobStarted
    const jobs = selectedJobEnabled ? [
      ...(!hideRestoredJobFromList ? [{ id: 'fixture-selected-job', company: 'Fixture Systems', role: 'Systems Engineer', status: 'saved' }] : []),
      ...(selectedJobTurnGateRegression ? [{ id: 'fixture-selected-job-next', company: 'Northstar Robotics', role: 'Principal Engineer', status: 'saved' }] : []),
    ] : []
    if (url.searchParams.get('status') === 'saved') fixture.selectedJobListResponses.push(jobs.map(job => job.id))
    return json(route, { jobs, total: jobs.length, page: 1, pageSize: 100, statusCounts: {} })
  })
  await page.route('**/api/resume', route => json(route, []))
  await page.route('**/api/agent', route => json(route, { autoApply: false, requireApproval: true, isRunning: false }))
  await page.route('**/api/agent/roles', route => json(route, []))
  await page.route('**/api/agent/roles/custom', route => json(route, []))
  await page.route('**/api/agent/automations', route => json(route, { automations: [] }))
  await page.route('**/api/agent/health', route => json(route, { successRate: 100, captchaRate: 0, avgDurationMs: 1200, patternCacheRate: 100, last24hRuns: 1 }))
  await page.route('**/api/notifications**', route => json(route, { notifications: [], unreadCount: 0 }))
  await page.route('**/api/gmail/unread', route => json(route, { hasGmail: false, unread: 0 }))
  await page.route('**/__agent_fixture__/lifecycle', async route => {
    fixture.lifecycleStarted = true
    return json(route, { ok: true })
  })
  await page.route('**/__agent_fixture__/replay', async route => {
    fixture.replayArmed = true
    return json(route, { ok: true })
  })
  await page.route('**/__agent_fixture__/selected-job-disconnect', async route => {
    fixture.selectedJobDisconnectArmed = true
    fixture.selectedJobStreamSequences = []
    fixture.selectedJobReconnectSequence = null
    return json(route, { ok: true })
  })
  await page.route('**/__agent_fixture__/selected-job-graph', async route => {
    fixture.selectedJobGraphReleaseArmed = true
    return json(route, { ok: true })
  })
  await page.route('**/__agent_fixture__/retryable', async route => {
    fixture.retryTurnStatus = 'failed'
    fixture.lifecycleStarted = false
    return json(route, { ok: true })
  })
  await page.route(/\/api\/agent\/sessions(?:\?.*)?$/, route => json(route, {
    sessions: [
      { id: SESSION_A, goal: 'Inspect saved roles', status: stageStatus(), updatedAt: times.updated, memorySummary: 'Current fixture execution.' },
      { id: SESSION_B, goal: 'B session evidence', status: 'completed', updatedAt: times.updated, memorySummary: 'Second session.' },
    ],
    lastOpenedSessionId: SESSION_A,
  }))

  await page.route('**/api/agent/sessions/**', async route => {
    const url = new URL(route.request().url())
    const parts = url.pathname.split('/').filter(Boolean)
    const sessionId = parts[3]
    const resource = parts[4] ?? ''
    if (resource === 'messages' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      if (selectedJobTurnGateRegression && !('selectedJobPreparation' in body)) {
        fixture.ordinaryChatRequests.push(body)
        return json(route, { inputId: 'fixture-ordinary-chat-input', turnId: ORDINARY_CHAT_TURN, disposition: 'started', sequence: '102' }, 202)
      }
      fixture.selectedJobRequests.push(body)
      fixture.selectedJobStarted = true
      return json(route, {
        inputId: 'fixture-preparation-input',
        turnId: selectedJobTurnGateRegression ? SELECTED_JOB_TURN_B : SELECTED_JOB_TURN_A,
        disposition: 'started',
        sequence: '99',
      }, 202)
    }
    if (resource === 'artifacts' && route.request().method() === 'GET') {
      const url = new URL(route.request().url())
      if (selectedJobTurnGateRegression && parts[5] === 'fixture-cover-letter-next') {
        const validNextRef = url.searchParams.get('contentHash') === `sha256:${'c'.repeat(64)}`
          && url.searchParams.get('sourceDigest') === `sha256:${'d'.repeat(64)}`
        if (sessionId !== SESSION_A || parts[7] !== '1' || !fixture.selectedJobGraphEventSent || !validNextRef) {
          return json(route, { error: 'Not found' }, 404)
        }
        return json(route, {
          job: { company: 'Northstar Robotics', role: 'Principal Engineer' },
          isCurrentVersion: true,
          artifact: {
            artifactId: 'fixture-cover-letter-next', version: 1, contentHash: `sha256:${'c'.repeat(64)}`, sourceDigest: `sha256:${'d'.repeat(64)}`,
            content: { text: 'Second selected-job cover-letter fixture body.' }, provenanceRefs: ['persona:fixture-fact-next'], evidenceRefs: ['job:fixture-selected-job-next'],
          },
          review: null,
          sourceEvidence: { freshness: 'current', items: [
            { reference: 'job:fixture-selected-job-next', kind: 'job', label: 'Job description', text: 'Build principal robotics systems.' },
            { reference: 'persona:fixture-fact-next', kind: 'persona', label: 'Profile fact · experience', text: 'Led reliable backend projects.' },
          ] },
        })
      }
      const validRef = url.searchParams.get('contentHash') === `sha256:${'a'.repeat(64)}`
        && url.searchParams.get('sourceDigest') === `sha256:${'b'.repeat(64)}`
      if (sessionId !== SESSION_A || parts[5] !== 'fixture-cover-letter' || parts[7] !== '1' || !fixture.selectedJobStarted || !validRef) {
        return json(route, { error: 'Not found' }, 404)
      }
      return json(route, {
        job: { company: 'Fixture Systems', role: 'Systems Engineer' },
        isCurrentVersion: !selectedJobHistoricalArtifact,
        artifact: {
          artifactId: 'fixture-cover-letter', version: 1, contentHash: `sha256:${'a'.repeat(64)}`, sourceDigest: `sha256:${'b'.repeat(64)}`,
          content: { text: 'Persisted cover-letter fixture body.' }, provenanceRefs: ['persona:fixture-fact'], evidenceRefs: ['job:fixture-selected-job'],
        },
        review: { status: 'passed', reviewHash: 'fixture-review-hash', evidenceRefs: ['resume:fixture-fact'], findings: [
          { code: 'unsupported_claim', severity: 'warning', message: 'Confirm this claim against your resume.', evidenceRefs: ['resume:fixture-fact'] },
        ] },
        sourceEvidence: selectedJobHistoricalArtifact
          ? { freshness: 'current', items: [
            { reference: 'resume:historical-private-source', kind: 'resume', label: 'Private source', text: 'PRIVATE_HISTORICAL_SOURCE_SHOULD_NOT_RENDER' },
          ] }
          : { freshness: 'current', items: [
            { reference: 'job:fixture-selected-job', kind: 'job', label: 'Job description', text: 'Build reliable cloud systems with TypeScript.' },
            { reference: 'resume:fixture-fact', kind: 'resume', label: 'Base resume', text: 'Delivered production services using TypeScript.' },
            { reference: 'persona:fixture-fact', kind: 'persona', label: 'Profile fact · experience', text: 'Led backend reliability work.' },
          ] },
      })
    }
    if (resource === 'approvals' && route.request().method() === 'POST') {
      fixture.approvalDecisions.push({
        sessionId,
        approvalId: parts[5] ?? '',
        body: route.request().postDataJSON() as Record<string, unknown>,
        idempotencyKey: route.request().headers()['idempotency-key'],
      })
      return json(route, { disposition: 'resolved' }, 202)
    }
    if (resource === 'turns') {
      if (parts[6] === 'retry' && route.request().method() === 'POST') {
        fixture.retryRequests.push({
          sessionId,
          turnId: parts[5] ?? '',
          body: route.request().postDataJSON() as Record<string, unknown>,
          idempotencyKey: route.request().headers()['idempotency-key'],
        })
        return json(route, { inputId: 'fixture-retry-input', turnId: TURN_A, disposition: 'started', sequence: '1' }, 202)
      }
      const selectedStatus = sessionId === SESSION_A ? stageStatus() : 'completed'
      const selected = sessionId === SESSION_A
        ? turn(SESSION_A, TURN_A, selectedStatus, selectedStatus === 'completed' || selectedStatus === 'failed' ? null : STEP_A)
        : turn(SESSION_B, TURN_B, 'completed', null)
      const preparationTurn = selectedJobPendingWriter && sessionId === SESSION_A && fixture.selectedJobStarted
        ? { ...turn(SESSION_A, SELECTED_JOB_TURN_A, 'in_progress', null), selectedJobId: 'fixture-selected-job' }
        : null
      return json(route, { turns: preparationTurn ? [selected, preparationTurn] : [selected], projection: { activeTurnId: selected.status === 'completed' ? null : selected.id, activeTurn: selected.status === 'completed' ? null : { id: selected.id, status: selected.status, revision: selected.revision }, queuedInputCount: 0 } })
    }
    if (resource === 'tasks') {
      fixture.tasksQueryCount += 1
      const selected = sessionId === SESSION_A ? stageStatus() : 'completed'
      const tasks = [{ id: `task-${sessionId}`, sessionId, turnId: sessionId === SESSION_A ? TURN_A : TURN_B, parentTaskId: null, role: 'Scout', taskType: 'read', status: selected, goal: sessionId === SESSION_A ? 'Inspect saved roles' : 'B session evidence', hasResult: selected === 'completed' }]
      if (sessionId === SESSION_A) tasks.push({ id: CHILD_TASK_A, sessionId, turnId: TURN_A, parentTaskId: `task-${SESSION_A}`, role: 'Scout', taskType: 'research', status: childStatus(), goal: 'Check child evidence', hasResult: childStatus() === 'completed' })
      if (sessionId === SESSION_A && selectedJobTurnGateRegression) {
        tasks.push({
          id: 'selected-job-plan-root', sessionId, turnId: SELECTED_JOB_TURN_A, rootTaskId: 'selected-job-plan-root', parentTaskId: null,
          role: 'orchestrator', taskType: 'root', status: 'completed', goal: 'Prepare Systems Engineer at Fixture Systems', hasResult: true,
        })
        tasks.push({
          id: 'writer-fixture-draft', sessionId, turnId: SELECTED_JOB_TURN_A, rootTaskId: 'selected-job-plan-root', parentTaskId: 'selected-job-plan-root',
          role: 'writer', taskType: 'cover_letter_draft', status: 'completed', goal: 'Prepare Systems Engineer at Fixture Systems', hasResult: true,
          artifactRef: { artifactId: 'fixture-cover-letter', version: 1, contentHash: `sha256:${'a'.repeat(64)}`, sourceDigest: `sha256:${'b'.repeat(64)}` },
          updatedAt: times.updated,
        })
        if (fixture.selectedJobGraphEventSent) {
          tasks.push({
            id: 'selected-job-plan-root-next', sessionId, turnId: SELECTED_JOB_TURN_B, rootTaskId: 'selected-job-plan-root-next', parentTaskId: null,
            role: 'orchestrator', taskType: 'root', status: 'completed', goal: 'Prepare Principal Engineer at Northstar Robotics', hasResult: true,
          })
          tasks.push({
            id: 'writer-fixture-draft-next', sessionId, turnId: SELECTED_JOB_TURN_B, rootTaskId: 'selected-job-plan-root-next', parentTaskId: 'selected-job-plan-root-next',
            role: 'writer', taskType: 'cover_letter_draft', status: 'completed', goal: 'Prepare Principal Engineer at Northstar Robotics', hasResult: true,
            artifactRef: { artifactId: 'fixture-cover-letter-next', version: 1, contentHash: `sha256:${'c'.repeat(64)}`, sourceDigest: `sha256:${'d'.repeat(64)}` },
            updatedAt: times.updated,
          })
        }
      } else if (sessionId === SESSION_A) {
        tasks.push({
          id: 'selected-job-plan-root', sessionId, turnId: 'fixture-preparation-turn', rootTaskId: 'selected-job-plan-root', parentTaskId: null,
          role: 'orchestrator', taskType: 'root', status: 'running', goal: 'Prepare the selected saved job', hasResult: false,
        })
        tasks.push({
          id: 'writer-fixture-draft', sessionId, turnId: 'fixture-preparation-turn', rootTaskId: 'selected-job-plan-root', parentTaskId: 'selected-job-plan-root',
          role: 'writer', taskType: 'cover_letter_draft', status: fixture.selectedJobStarted && !selectedJobPendingWriter ? 'completed' : 'queued', goal: 'Prepare the selected saved job', hasResult: fixture.selectedJobStarted && !selectedJobPendingWriter,
          ...(fixture.selectedJobStarted && !selectedJobPendingWriter ? { artifactRef: { artifactId: 'fixture-cover-letter', version: 1, contentHash: `sha256:${'a'.repeat(64)}`, sourceDigest: `sha256:${'b'.repeat(64)}` } } : {}),
          updatedAt: times.updated,
        })
      }
      return json(route, { tasks })
    }
    if (resource === 'timeline') {
      if (sessionId === SESSION_A && selectedJobPendingWriter) {
        const items = [
          item(SESSION_A, TURN_A, 'fixture-plan-a', 'Read the current session plan.', { type: 'plan', phase: 'commentary', content: { steps: [{ id: 'step-a', label: 'Inspect saved roles', status: 'queued' }] } }),
          item(SESSION_A, TURN_A, 'fixture-tool-a', 'Read the saved roles.', { type: 'tool_call', phase: 'commentary', content: { toolCallId: 'call-a', toolName: 'jobs.search', input: { scope: 'saved roles' } } }),
          item(SESSION_A, TURN_A, ITEM_A, 'The agent is executing the saved roles check.', { status: stageStatus() === 'completed' ? 'completed' : 'queued' }),
        ]
        if (fixture.selectedJobStarted) {
          items.push(item(SESSION_A, SELECTED_JOB_TURN_A, 'fixture-selected-job-request', SELECTED_JOB_TEXT, {
            stepId: null, type: 'user_message', sequence: '99', content: { parts: [{ type: 'text', text: SELECTED_JOB_TEXT }] },
          }))
          items.push(item(SESSION_A, SELECTED_JOB_TURN_A, 'fixture-selected-job-task-graph', 'Prepare Systems Engineer at Fixture Systems.', {
            stepId: null, type: 'task_graph', taskId: 'selected-job-plan-root', revision: 4,
            content: { schemaVersion: 'agent-harness.v2.task-graph', nodes: [
              { key: 'cover-letter', templateId: 'writer', goal: 'Prepare Systems Engineer at Fixture Systems', successCriteria: ['Save a reviewable draft'], dependsOn: [], depth: 1, taskId: 'writer-fixture-draft' },
            ] },
          }))
        }
        return json(route, { items, approvalEvents: [] })
      }
      if (sessionId === SESSION_A && selectedJobTurnGateRegression) {
        const items = [
          item(SESSION_A, TURN_A, 'fixture-plan-a', 'Read the current session plan.', { type: 'plan', phase: 'commentary', content: { steps: [{ id: 'step-a', label: 'Inspect saved roles', status: 'queued' }] } }),
          item(SESSION_A, TURN_A, 'fixture-tool-a', 'Read the saved roles.', { type: 'tool_call', phase: 'commentary', content: { toolCallId: 'call-a', toolName: 'jobs.search', input: { scope: 'saved roles' } } }),
          item(SESSION_A, TURN_A, ITEM_A, 'The agent is executing the saved roles check.', { status: stageStatus() === 'completed' ? 'completed' : 'queued' }),
          item(SESSION_A, SELECTED_JOB_TURN_A, 'fixture-selected-job-request-first', SELECTED_JOB_TEXT, {
            stepId: null, type: 'user_message', sequence: '10', content: { parts: [{ type: 'text', text: SELECTED_JOB_TEXT }] },
          }),
          item(SESSION_A, SELECTED_JOB_TURN_A, 'fixture-selected-job-task-graph-first', 'Prepare Systems Engineer at Fixture Systems.', {
            stepId: null, type: 'task_graph', taskId: 'selected-job-plan-root', revision: 4,
            content: { schemaVersion: 'agent-harness.v2.task-graph', nodes: [
              { key: 'cover-letter-first', templateId: 'writer', goal: 'Prepare Systems Engineer at Fixture Systems', successCriteria: ['Save a reviewable draft'], dependsOn: [], depth: 1, taskId: 'writer-fixture-draft' },
            ] },
          }),
        ]
        if (fixture.selectedJobGraphEventSent) items.push(item(SESSION_A, SELECTED_JOB_TURN_B, 'fixture-selected-job-task-graph-next', 'Prepare Principal Engineer at Northstar Robotics.', {
          stepId: null, type: 'task_graph', taskId: 'selected-job-plan-root-next', revision: 5,
          content: { schemaVersion: 'agent-harness.v2.task-graph', nodes: [
            { key: 'cover-letter-next', templateId: 'writer', goal: 'Prepare Principal Engineer at Northstar Robotics', successCriteria: ['Save a reviewable draft'], dependsOn: [], depth: 1, taskId: 'writer-fixture-draft-next' },
          ] },
        }))
        return json(route, { items, approvalEvents: [] })
      }
      return json(route, { items: sessionId === SESSION_A
        ? [
            item(SESSION_A, TURN_A, 'fixture-plan-a', 'Read the current session plan.', { type: 'plan', phase: 'commentary', content: { steps: [{ id: 'step-a', label: 'Inspect saved roles', status: 'queued' }] } }),
            item(SESSION_A, TURN_A, 'fixture-tool-a', 'Read the saved roles.', { type: 'tool_call', phase: 'commentary', content: { toolCallId: 'call-a', toolName: 'jobs.search', input: { scope: 'saved roles' } } }),
            item(SESSION_A, TURN_A, ITEM_A, 'The agent is executing the saved roles check.', { status: stageStatus() === 'completed' ? 'completed' : 'queued' }),
            item(SESSION_A, 'fixture-preparation-turn', 'fixture-selected-job-task-graph', 'Prepare the selected saved job.', {
              stepId: null, type: 'task_graph', taskId: 'selected-job-plan-root', revision: 4,
              content: { schemaVersion: 'agent-harness.v2.task-graph', nodes: [
                { key: 'cover-letter', templateId: 'writer', goal: 'Prepare the selected saved job', successCriteria: ['Save a reviewable draft'], dependsOn: [], depth: 1, taskId: 'writer-fixture-draft' },
              ] },
            }),
          ]
        : [item(SESSION_B, TURN_B, ITEM_B, 'B session evidence is isolated from session A.', { status: 'completed', phase: 'final_answer', completedAt: times.updated })],
        approvalEvents: sessionId === SESSION_A
          ? [event(SESSION_A, TURN_A, 'fixture-approval-requested', '0', 'approval.requested', { approvalId: APPROVAL_ID, action: 'submit_application', scopeHash: `sha256:${'a'.repeat(64)}`, revision: 1 }, { itemId: null, taskId: null, actor: 'orchestrator' })]
          : [],
      })
    }
    if (resource === 'events') {
      if (sessionId !== SESSION_A) {
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture B stream\n\n' })
      }
      if (fixture.selectedJobDisconnectArmed) {
        const afterSequence = url.searchParams.get('afterSequence')
        fixture.selectedJobStreamSequences.push(afterSequence)
        if (fixture.selectedJobStreamSequences.length === 1) {
          fixture.selectedJobReconnectSequence = (BigInt(afterSequence ?? '0') + BigInt(1)).toString()
          const disconnectEvent = event(SESSION_A, TURN_A, 'fixture-selected-job-disconnect', fixture.selectedJobReconnectSequence, 'turn.started', { status: 'in_progress' }, { itemId: null })
          return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: timeline\ndata: ${JSON.stringify(disconnectEvent)}\n\n` })
        }
        if (fixture.selectedJobStreamSequences.length === 2) {
          fixture.selectedJobDisconnectArmed = false
          return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': selected-job stream reconnected\n\n' })
        }
      }
      if (selectedJobTurnGateRegression && fixture.selectedJobGraphReleaseArmed && !fixture.selectedJobGraphEventSent) {
        fixture.selectedJobGraphEventSent = true
        fixture.eventSequence = 101
        const graphItem = item(SESSION_A, SELECTED_JOB_TURN_B, 'fixture-selected-job-task-graph-next', 'Prepare Principal Engineer at Northstar Robotics.', {
          stepId: null, type: 'task_graph', taskId: 'selected-job-plan-root-next', revision: 5,
          content: { schemaVersion: 'agent-harness.v2.task-graph', nodes: [
            { key: 'cover-letter-next', templateId: 'writer', goal: 'Prepare Principal Engineer at Northstar Robotics', successCriteria: ['Save a reviewable draft'], dependsOn: [], depth: 1, taskId: 'writer-fixture-draft-next' },
          ] },
        })
        const graphEvent = event(SESSION_A, SELECTED_JOB_TURN_B, 'fixture-event-selected-job-task-graph-next', '101', 'item.started', { item: graphItem }, { itemId: graphItem.id, taskId: graphItem.taskId })
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: timeline\ndata: ${JSON.stringify(graphEvent)}\n\n` })
      }
      if (selectedJobTurnGateRegression && fixture.ordinaryChatRequests.length > 0 && !fixture.ordinaryChatEventSent) {
        fixture.ordinaryChatEventSent = true
        fixture.eventSequence = 103
        const chatItem = item(SESSION_A, ORDINARY_CHAT_TURN, 'fixture-ordinary-chat-message', 'Keep the current draft visible.', {
          stepId: null, type: 'user_message', sequence: '103', content: { parts: [{ type: 'text', text: 'Keep the current draft visible.' }] },
        })
        const chatEvent = event(SESSION_A, ORDINARY_CHAT_TURN, 'fixture-event-ordinary-chat-message', '103', 'item.started', { item: chatItem }, { itemId: chatItem.id })
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: timeline\ndata: ${JSON.stringify(chatEvent)}\n\n` })
      }
      if (!fixture.lifecycleStarted) {
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': waiting for lifecycle assertions\n\n' })
      }
      if (fixture.replayArmed) {
        const afterSequence = url.searchParams.get('afterSequence')
        fixture.replayRequestsAfterSequence.push(afterSequence)
        if (fixture.replayRequestsAfterSequence.length === 1) {
          fixture.replaySequence = (BigInt(afterSequence ?? '0') + BigInt(1)).toString()
          fixture.eventSequence = Number(fixture.replaySequence)
          fixture.replayEvent = event(SESSION_A, TURN_A, 'fixture-event-selected-tool-replay', fixture.replaySequence, 'item.delta', {
            text: 'Selected tool evidence survived the disconnect.',
            outputSummary: 'Selected tool evidence survived the disconnect.',
          }, {
            itemId: 'fixture-tool-a', kind: 'delta', baseRevision: 1, revision: 2,
          })
          // Ending this response closes the mocked SSE connection. The client must reconnect with the emitted sequence.
          return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: timeline\ndata: ${JSON.stringify(fixture.replayEvent)}\n\n` })
        }
        if (fixture.replayRequestsAfterSequence.length === 2) {
          if (!fixture.replayEvent) throw new Error('The replay fixture event was not initialized.')
          fixture.replayDuplicateSent = true
          fixture.replayArmed = false
          return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: timeline\ndata: ${JSON.stringify(fixture.replayEvent)}\n\n` })
        }
      }
      fixture.aStreamCount += 1
      const count = fixture.aStreamCount
      // Keep each lifecycle state visible long enough for the browser assertion to observe it.
      await new Promise(resolve => setTimeout(resolve, 1_000))
      const nextEvent = count === 1
        ? event(SESSION_A, TURN_A, 'fixture-event-running', nextEventSequence(), 'turn.started', { status: 'in_progress' }, { itemId: null })
        : count === 2
          ? event(SESSION_A, TURN_A, 'fixture-event-waiting', nextEventSequence(), 'step.started', { status: 'waiting_for_user' }, { itemId: null, taskId: `task-${SESSION_A}` })
          : count === 3
            ? event(SESSION_A, TURN_A, 'fixture-event-child-started', nextEventSequence(), 'task.started', { status: 'running' }, { itemId: null, taskId: CHILD_TASK_A })
            : count === 4
              ? event(SESSION_A, TURN_A, 'fixture-event-child-completed', nextEventSequence(), 'task.completed', { status: 'completed' }, { itemId: null, taskId: CHILD_TASK_A })
              : count === 5
                ? event(SESSION_A, TURN_A, 'fixture-event-completed', nextEventSequence(), 'turn.completed', { status: 'completed' }, { itemId: null })
                : event(SESSION_A, TURN_A, `fixture-event-late-${count}`, nextEventSequence(), 'item.delta', { text: 'A late old-session event must stay discarded.' }, { itemId: ITEM_A, kind: 'delta', baseRevision: 3, revision: 4 })
      if (count === 3) {
        fixture.tasksQueryCountAtStartEvent = fixture.tasksQueryCount
        fixture.childTaskStarted = true
        fixture.taskLifecycleConnections.push(count)
      } else if (count === 4) {
        fixture.tasksQueryCountAtCompletedEvent = fixture.tasksQueryCount
        fixture.childTaskCompleted = true
        fixture.taskLifecycleConnections.push(count)
      }
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: timeline\ndata: ${JSON.stringify(nextEvent)}\n\n` })
    }
    if (route.request().method() === 'PATCH') return json(route, {})
    return json(route, { session: { id: sessionId, goal: sessionId === SESSION_A ? 'Inspect saved roles' : 'B session evidence', status: sessionId === SESSION_A ? stageStatus() : 'completed', updatedAt: times.updated, tasks: [], approvals: [], applicationTasks: [], questions: [], artifacts: [], qualityScore: 100 } })
  })
  return fixture
}

test('real page mounts the shared timeline, supervisor tree, and isolated session evidence', async ({ page }, testInfo) => {
  const fixture = await installSupervisorFixture(page)
  const consoleErrors: string[] = []
  const submissionRequests: string[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (/^\/api\/jobs\/[^/]+\/apply$/.test(url.pathname)) submissionRequests.push(url.pathname)
  })
  page.on('pageerror', error => consoleErrors.push(`pageerror: ${error.stack ?? error.message}`))
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(`console: ${message.text()}`)
  })
  const isZh = testInfo.project.name.includes('zh')
  await page.goto(`/agent-preview?supervisor=1&applicationReview=1&locale=${isZh ? 'zh' : 'en'}&sessionId=${SESSION_A}`)

  const supervisor = page.locator('[data-agent-supervisor-panel]')
  await expect(supervisor).toBeVisible({ timeout: 20_000 })
  const liveStream = page.locator('.agent-live-stream-body')
  await expect(liveStream).toContainText(isZh ? '申请队列' : 'Application queue')
  await expect(liveStream).toContainText('Fixture Robotics')
  await expect(liveStream).toContainText('Backend Engineer')
  const reviewLetterButton = liveStream.getByRole('button', { name: isZh ? /查看求职信/ : /View cover letter/ })
  await expect(reviewLetterButton).toBeVisible()
  await reviewLetterButton.click()
  await expect(liveStream).toContainText('Fixture cover letter for review only. No application will be submitted.')
  const applyNowButton = liveStream.getByRole('button', { name: isZh ? /立即投递/ : /Apply now/ })
  await expect(applyNowButton).toBeVisible()
  await expect(applyNowButton).toBeEnabled()
  expect(submissionRequests).toEqual([])
  await expect(page.locator('[data-agent-harness-item="fixture-item-a"]')).toBeVisible()
  await expect(page.locator('[data-agent-harness-item="fixture-item-a"]')).toHaveCount(1)
  const labels = isZh
    ? { queued: /排队任务/, running: /运行中/, waiting: /等待中/, done: /完成/, connection: /实时连接|正在重新连接/ }
    : { queued: /Queued Tasks/, running: /Running/, waiting: /Waiting/, done: /Done/, connection: /Live connection|Reconnecting/ }
  const taskNode = page.locator('[data-task-node-id="task:task-fixture-session-a"]')
  const childTaskNode = page.locator(`[data-task-node-id="task:${CHILD_TASK_A}"]`)
  const stepNode = supervisor.locator('[data-task-node-id="step:fixture-step-a"]')
  await expect(taskNode).toContainText(labels.queued)
  await expect(childTaskNode).toContainText(labels.queued)
  await expect(stepNode).toHaveCount(1)
  await expect(stepNode).toContainText(labels.queued)
  await expect(page.locator('[data-agent-supervisor-connection]')).toContainText(labels.connection)

  const approvalCard = page.locator('[data-agent-approval-ledger="true"]')
  await expect(approvalCard).toBeVisible()
  const approveButton = approvalCard.getByRole('button').first()
  await expect(approveButton).toBeEnabled()
  await approveButton.click()
  await expect(approveButton).toBeDisabled()
  await expect.poll(() => fixture.approvalDecisions.length).toBe(1)
  expect(fixture.approvalDecisions[0]).toMatchObject({
    sessionId: SESSION_A,
    approvalId: APPROVAL_ID,
    body: { expectedTurnId: TURN_A, expectedRevision: 1, decision: 'approved' },
  })
  expect(fixture.approvalDecisions[0]?.idempotencyKey).toMatch(/^agent-approval-/)

  await page.evaluate(() => fetch('/__agent_fixture__/lifecycle', { method: 'POST' }))

  await expect(taskNode).toContainText(labels.running, { timeout: 5_000 })
  await expect(stepNode).toContainText(labels.running, { timeout: 5_000 })
  await expect(taskNode).toContainText(labels.waiting, { timeout: 5_000 })
  await expect(stepNode).toContainText(labels.waiting, { timeout: 5_000 })
  await expect(childTaskNode).toContainText(labels.running, { timeout: 5_000 })
  await expect.poll(() => fixture.tasksQueryCount).toBeGreaterThan(fixture.tasksQueryCountAtStartEvent)
  await expect(childTaskNode).toContainText(labels.done, { timeout: 5_000 })
  await expect.poll(() => fixture.tasksQueryCount).toBeGreaterThan(fixture.tasksQueryCountAtCompletedEvent)
  expect(fixture.taskLifecycleConnections).toEqual([3, 4])
  await expect(taskNode).toContainText(labels.done, { timeout: 5_000 })
  await expect(page.locator('[data-agent-harness-item="fixture-item-a"]')).toContainText(labels.queued)

  if (testInfo.project.name === 'desktop-en' || testInfo.project.name === 'mobile-en') {
    const artifactDir = path.join(process.cwd(), 'apps', 'web', 'tests', 'e2e', '__artifacts__')
    await page.screenshot({ path: path.join(artifactDir, `agent-supervisor-${testInfo.project.name}-a.png`), fullPage: true })
  }

  const toolNode = page.locator('[data-task-node-id^="tool:"]').first()
  await toolNode.click()
  await expect(page.locator('[data-agent-supervisor-selection]')).toBeVisible()
  await expect(toolNode).toHaveAttribute('aria-current', 'true')
  await expect(page.locator('[data-agent-supervisor-selection]')).toContainText('jobs.search')
  await expect(page.locator('[data-agent-harness-item="fixture-tool-a"]')).toBeVisible()
  await expect(page.locator('[data-agent-harness-item="fixture-tool-a"]')).toHaveCount(1)
  await page.evaluate(() => fetch('/__agent_fixture__/replay', { method: 'POST' }))
  await expect.poll(() => fixture.replayRequestsAfterSequence.length).toBe(2)
  expect(fixture.replayDuplicateSent).toBe(true)
  expect(fixture.replaySequence).not.toBeNull()
  expect(fixture.replayRequestsAfterSequence[1]).toBe(fixture.replaySequence)
  await expect(page.locator('[data-agent-supervisor-connection]')).toContainText(labels.connection)
  await expect(childTaskNode).toContainText(labels.done)
  await expect(stepNode).toContainText(labels.running)
  await expect(page.locator('[data-agent-supervisor-selection]')).toBeVisible()
  await expect(page.locator('[data-agent-supervisor-selection]')).toContainText('jobs.search')
  await expect(page.locator('[data-agent-harness-item="fixture-tool-a"]')).toHaveCount(1)
  await expect(page.locator('[data-agent-harness-item="fixture-tool-a"]')).toContainText('Selected tool evidence survived the disconnect.')
  await expect.poll(async () => page.evaluate(() => {
    const item = document.querySelector<HTMLElement>('[data-agent-harness-item="fixture-tool-a"]')
    const streamBody = document.querySelector<HTMLElement>('.agent-live-stream-body')
    if (!item || !streamBody) return false
    const itemRect = item.getBoundingClientRect()
    const streamRect = streamBody.getBoundingClientRect()
    return itemRect.top >= streamRect.top && itemRect.bottom <= streamRect.bottom
  })).toBe(true)

  if ((await page.evaluate(() => window.innerWidth)) <= 900) {
    await page.getByRole('button', { name: isZh ? '对话' : 'Conversations', exact: true }).click()
  }
  await page.getByText('B session evidence', { exact: true }).click()
  await expect(page.locator('[data-agent-harness-item="fixture-item-b"]')).toBeVisible({ timeout: 5_000 })
  await expect(page.locator('[data-agent-harness-item="fixture-item-a"]')).toHaveCount(0)
  await expect(page.locator('.agent-composer textarea')).toBeVisible()
  const mobileLayout = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('[data-agent-supervisor-panel]')?.getBoundingClientRect()
    const composer = document.querySelector<HTMLTextAreaElement>('.agent-composer textarea')?.getBoundingClientRect()
    return { panelHeight: panel?.height ?? 0, composerHeight: composer?.height ?? 0, viewportHeight: window.innerHeight }
  })
  if ((await page.evaluate(() => window.innerWidth)) <= 900) {
    expect(mobileLayout.composerHeight).toBeGreaterThan(40)
    expect(mobileLayout.panelHeight).toBeLessThanOrEqual(mobileLayout.viewportHeight * 0.5)
  }
  await expect(page.locator('body')).not.toContainText('A late old-session event must stay discarded')
  expect(submissionRequests).toEqual([])

  const artifactDir = path.join(process.cwd(), 'apps', 'web', 'tests', 'e2e', '__artifacts__')
  if (testInfo.project.name === 'desktop-en' || testInfo.project.name === 'mobile-en') {
    await page.screenshot({ path: path.join(artifactDir, `agent-supervisor-${testInfo.project.name}.png`), fullPage: true })
  }

  await page.evaluate(() => fetch('/__agent_fixture__/retryable', { method: 'POST' }))
  if ((await page.evaluate(() => window.innerWidth)) <= 900) {
    await page.getByRole('button', { name: isZh ? '对话' : 'Conversations', exact: true }).click()
  }
  await page.getByText('Inspect saved roles', { exact: true }).click()
  const retryableTurn = page.locator(`[data-task-node-id="turn:${TURN_A}"]`)
  await expect(retryableTurn).toBeVisible({ timeout: 20_000 })
  await retryableTurn.click()
  const retryPanel = page.locator('[data-agent-turn-retry="true"]')
  await expect(retryPanel).toBeVisible()
  const retryButton = retryPanel.getByRole('button', { name: isZh ? '重试' : 'Retry' })
  await expect(retryButton).toBeEnabled()
  await retryButton.click()
  await expect.poll(() => fixture.retryRequests.length).toBe(1)
  expect(fixture.retryRequests[0]).toMatchObject({
    sessionId: SESSION_A,
    turnId: TURN_A,
    body: { expectedRevision: 1, clientMessageId: expect.any(String) },
  })
  expect(fixture.retryRequests[0]?.idempotencyKey).toBe(fixture.retryRequests[0]?.body.clientMessageId)
  expect(fixture.retryRequests[0]?.idempotencyKey).toMatch(/^agent-turn-retry-/)
  await expect(retryPanel.locator('[data-agent-turn-retry-status="accepted"]')).toBeVisible()
  expect(submissionRequests).toEqual([])
  expect(consoleErrors).toEqual([])
})

test('selected-job preparation sends typed scope and restores the persisted draft after stream reconnect', async ({ page }, testInfo) => {
  const fixture = await installSupervisorFixture(page, true)
  const isZh = testInfo.project.name.includes('zh')
  await page.goto(`/agent-preview?supervisor=1&locale=${isZh ? 'zh' : 'en'}&sessionId=${SESSION_A}`)

  const preparation = page.locator('[data-selected-job-preparation="true"]')
  await expect(preparation).toBeVisible({ timeout: 20_000 })
  await preparation.getByLabel(isZh ? '已保存的职位' : 'Saved job').selectOption('fixture-selected-job')
  await preparation.getByRole('button', { name: isZh ? '准备草稿' : 'Prepare draft' }).click()
  await expect.poll(() => fixture.selectedJobRequests.length).toBe(1)
  const command = fixture.selectedJobRequests[0]
  expect(command).toMatchObject({ delivery: 'follow_up', selectedJobPreparation: { jobId: 'fixture-selected-job' } })
  expect(command?.content).toEqual([{ type: 'text', text: 'Prepare a cover letter draft for the selected job.' }])
  expect(JSON.stringify(command?.content)).not.toContain('fixture-selected-job')

  const draft = page.locator('[data-selected-job-draft="true"]')
  await expect(draft).toBeVisible({ timeout: 10_000 })
  await expect(draft).toHaveAttribute('aria-label', 'Systems Engineer · Fixture Systems v1')
  await expect(draft).toContainText('Persisted cover-letter fixture body.')
  await expect(draft).toContainText('persona:fixture-fact')
  await expect(draft).toContainText('job:fixture-selected-job')
  await expect(draft).toContainText('resume:fixture-fact')
  await expect(draft).toContainText(isZh ? '通过' : 'passed')
  await expect(draft).toHaveAttribute('data-draft-version', '1')
  await expect(draft).toContainText('unsupported_claim')
  await expect(draft).toContainText('Confirm this claim against your resume.')
  await expect(draft.locator('[data-draft-source-evidence="current"]')).toContainText(isZh ? '来源版本与草稿一致。' : 'References match the current source versions.')
  const jobEvidence = draft.locator('[data-source-evidence-item="job:fixture-selected-job"]')
  await expect(jobEvidence).toContainText(isZh ? '职位 · Job description' : 'Job · Job description')
  await expect(jobEvidence).toContainText('Build reliable cloud systems with TypeScript.')
  await expect(draft.locator('[data-source-evidence-item="resume:fixture-fact"]')).toContainText('Delivered production services using TypeScript.')

  const plan = page.locator('[data-agent-task-graph-plan="true"]')
  await expect(plan).toBeVisible({ timeout: 10_000 })
  await expect(plan).toHaveAttribute('data-agent-task-graph-session', SESSION_A)
  await expect(plan).toHaveAttribute('data-agent-task-graph-revision', '4')
  await expect(plan).toContainText('Prepare the selected saved job')
  await expect(plan.locator('ol li').first()).toContainText(isZh ? '已完成' : 'Completed')
  const planBeforeReconnect = await plan.evaluate(element => ({
    session: element.getAttribute('data-agent-task-graph-session'),
    revision: element.getAttribute('data-agent-task-graph-revision'),
    text: element.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  }))

  await page.evaluate(async () => {
    const response = await fetch('/__agent_fixture__/selected-job-disconnect', { method: 'POST' })
    if (!response.ok) throw new Error('Could not arm the selected-job stream disconnect fixture.')
  })
  await expect.poll(() => fixture.selectedJobStreamSequences.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
  expect(fixture.selectedJobReconnectSequence).not.toBeNull()
  expect(fixture.selectedJobStreamSequences[1]).toBe(fixture.selectedJobReconnectSequence)

  await expect(draft).toBeVisible()
  await expect(draft).toContainText('Persisted cover-letter fixture body.')
  await expect(draft).toHaveAttribute('aria-label', 'Systems Engineer · Fixture Systems v1')
  await expect(draft).toContainText('persona:fixture-fact')
  await expect(draft).toContainText('job:fixture-selected-job')
  await expect(draft).toContainText('resume:fixture-fact')
  await expect(draft).toHaveAttribute('data-draft-version', '1')
  await expect(draft).toContainText('unsupported_claim')
  await expect(draft).toContainText('Confirm this claim against your resume.')
  await expect(plan).toBeVisible()
  await expect(plan.locator('ol li').first()).toContainText(isZh ? '已完成' : 'Completed')
  expect(await plan.evaluate(element => ({
    session: element.getAttribute('data-agent-task-graph-session'),
    revision: element.getAttribute('data-agent-task-graph-revision'),
    text: element.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  }))).toEqual(planBeforeReconnect)

  // A full page refresh must rebuild the same Workbench view from persisted
  // session/task/artifact reads, rather than relying on the pre-disconnect UI.
  await page.reload()
  await expect(page.locator('[data-selected-job-draft="true"]')).toBeVisible({ timeout: 20_000 })
  const restoredDraft = page.locator('[data-selected-job-draft="true"]')
  await expect(restoredDraft).toHaveAttribute('aria-label', 'Systems Engineer · Fixture Systems v1')
  await expect(restoredDraft).toContainText('Persisted cover-letter fixture body.')
  await expect(restoredDraft).toContainText('persona:fixture-fact')
  await expect(restoredDraft).toContainText('job:fixture-selected-job')
  await expect(restoredDraft).toContainText('resume:fixture-fact')
  await expect(restoredDraft).toContainText(isZh ? '通过' : 'passed')
  await expect(restoredDraft).toContainText('unsupported_claim')
  await expect(restoredDraft.locator('[data-source-evidence-item="persona:fixture-fact"]')).toContainText('Led backend reliability work.')
  const restoredPlan = page.locator('[data-agent-task-graph-plan="true"]')
  await expect(restoredPlan).toBeVisible({ timeout: 10_000 })
  expect(await restoredPlan.evaluate(element => ({
    session: element.getAttribute('data-agent-task-graph-session'),
    revision: element.getAttribute('data-agent-task-graph-revision'),
    text: element.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  }))).toEqual(planBeforeReconnect)

  if ((await page.evaluate(() => window.innerWidth)) <= 900) await page.getByRole('button', { name: isZh ? '对话' : 'Conversations', exact: true }).click()
  await page.getByText('B session evidence', { exact: true }).click()
  await expect(page.locator('[data-selected-job-draft="true"]')).toHaveCount(0, { timeout: 10_000 })
  await expect(page.locator('body')).not.toContainText('Persisted cover-letter fixture body.')
  await expect(page.locator('[data-agent-task-graph-plan="true"]')).toHaveCount(0)
})

test('historical selected-job artifact warns, hides source text, and drops its prior passing review', async ({ page }, testInfo) => {
  const fixture = await installSupervisorFixture(page, true, false, false, true)
  const isZh = testInfo.project.name.includes('zh')
  await page.goto(`/agent-preview?supervisor=1&locale=${isZh ? 'zh' : 'en'}&sessionId=${SESSION_A}`)

  const preparation = page.locator('[data-selected-job-preparation="true"]')
  await expect(preparation).toBeVisible({ timeout: 20_000 })
  await preparation.getByLabel(isZh ? '已保存的职位' : 'Saved job').selectOption('fixture-selected-job')
  await preparation.getByRole('button', { name: isZh ? '准备草稿' : 'Prepare draft' }).click()
  await expect.poll(() => fixture.selectedJobRequests.length).toBe(1)

  const draft = page.locator('[data-selected-job-draft="true"]')
  await expect(draft).toBeVisible({ timeout: 10_000 })
  await expect(draft.locator('[data-draft-version-state="historical"]')).toContainText(
    isZh ? '此版本不是已确认的当前草稿；此前的审核结果已过期。' : 'This is not the confirmed current draft; any prior review is stale.',
  )
  const sourceEvidence = draft.locator('[data-draft-source-evidence="stale"]')
  await expect(sourceEvidence).toContainText(
    isZh ? '来源内容已变化；为避免误导，来源文本已隐藏。' : 'Sources changed after this draft; source text is hidden.',
  )
  await expect(sourceEvidence.locator('[data-source-evidence-item]')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('PRIVATE_HISTORICAL_SOURCE_SHOULD_NOT_RENDER')
  await expect(draft).toContainText(isZh ? '审核: 已过期' : 'Review: stale')
  await expect(draft).not.toContainText(isZh ? '通过' : 'passed')
  await expect(draft).not.toContainText('Confirm this claim against your resume.')
})

test('refresh restores the selected saved job and its graph before the Writer artifact exists without leaking across sessions', async ({ page }, testInfo) => {
  const fixture = await installSupervisorFixture(page, true, false, true)
  const isZh = testInfo.project.name.includes('zh')
  await page.goto('/agent-preview?supervisor=1&locale=' + (isZh ? 'zh' : 'en') + '&sessionId=' + SESSION_A)

  const preparation = page.locator('[data-selected-job-preparation="true"]')
  const savedJob = preparation.getByLabel(isZh ? '已保存的职位' : 'Saved job')
  await expect(preparation).toBeVisible({ timeout: 20_000 })
  await savedJob.selectOption('fixture-selected-job')
  await expect.poll(() => fixture.selectedJobListResponses.length).toBeGreaterThan(0)
  expect(fixture.selectedJobListResponses[0]).toContain('fixture-selected-job')
  await preparation.getByRole('button', { name: isZh ? '准备草稿' : 'Prepare draft' }).click()
  await expect.poll(() => fixture.selectedJobRequests.length).toBe(1)
  await expect(page.locator('[data-agent-task-graph-plan="true"]')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('[data-agent-task-graph-plan="true"]')).toContainText('Prepare Systems Engineer at Fixture Systems')
  await expect(page.locator('[data-selected-job-draft="true"]')).toHaveCount(0)

  await page.reload()
  await expect.poll(() => fixture.selectedJobDetailRequests.length, { timeout: 20_000 }).toBe(1)
  expect(fixture.selectedJobDetailRequests).toEqual(['/api/jobs/fixture-selected-job'])
  await expect.poll(() => fixture.selectedJobListResponses.length).toBeGreaterThan(1)
  expect(fixture.selectedJobListResponses[fixture.selectedJobListResponses.length - 1]).not.toContain('fixture-selected-job')
  const restoredPreparation = page.locator('[data-selected-job-preparation="true"]')
  const restoredSavedJob = restoredPreparation.getByLabel(isZh ? '已保存的职位' : 'Saved job')
  await expect(restoredSavedJob).toHaveValue('fixture-selected-job', { timeout: 20_000 })
  await expect(restoredSavedJob.locator('option:checked')).toContainText('Fixture Systems · Systems Engineer')
  const restoredPlan = page.locator('[data-agent-task-graph-plan="true"]')
  await expect(restoredPlan).toBeVisible({ timeout: 10_000 })
  await expect(restoredPlan).toContainText('Prepare Systems Engineer at Fixture Systems')
  await expect(page.locator('[data-selected-job-draft="true"]')).toHaveCount(0)

  if ((await page.evaluate(() => window.innerWidth)) <= 900) await page.getByRole('button', { name: isZh ? '对话' : 'Conversations', exact: true }).click()
  await page.getByText('B session evidence', { exact: true }).click()
  await expect(restoredSavedJob).toHaveValue('', { timeout: 10_000 })
  await expect(page.locator('[data-agent-task-graph-plan="true"]')).toHaveCount(0)
  await expect(page.locator('[data-selected-job-draft="true"]')).toHaveCount(0)

  if ((await page.evaluate(() => window.innerWidth)) <= 900) await page.getByRole('button', { name: isZh ? '对话' : 'Conversations', exact: true }).click()
  await page.getByText('Inspect saved roles', { exact: true }).click()
  await expect(page.locator('[data-selected-job-preparation="true"]').getByLabel(isZh ? '已保存的职位' : 'Saved job')).toHaveValue('fixture-selected-job', { timeout: 10_000 })
  await expect(page.locator('[data-agent-task-graph-plan="true"]')).toContainText('Prepare Systems Engineer at Fixture Systems')
})
test('a newer selected-job Turn hides the prior plan and draft until its graph arrives, while ordinary chat keeps them visible', async ({ page }, testInfo) => {
  const fixture = await installSupervisorFixture(page, true, true)
  const isZh = testInfo.project.name.includes('zh')
  await page.goto(`/agent-preview?supervisor=1&locale=${isZh ? 'zh' : 'en'}&sessionId=${SESSION_A}`)

  const preparation = page.locator('[data-selected-job-preparation="true"]')
  const plan = page.locator('[data-agent-task-graph-plan="true"]')
  const draft = page.locator('[data-selected-job-draft="true"]')
  await expect(preparation).toBeVisible({ timeout: 20_000 })
  await expect(plan).toBeVisible({ timeout: 10_000 })
  await expect(plan).toContainText('Prepare Systems Engineer at Fixture Systems')
  await expect(draft).toBeVisible({ timeout: 10_000 })
  await expect(draft).toHaveAttribute('aria-label', 'Systems Engineer · Fixture Systems v1')
  await expect(draft).toContainText('Persisted cover-letter fixture body.')

  await preparation.getByLabel(isZh ? '已保存的职位' : 'Saved job').selectOption('fixture-selected-job-next')
  await preparation.getByRole('button', { name: isZh ? '准备草稿' : 'Prepare draft' }).click()
  await expect.poll(() => fixture.selectedJobRequests.length).toBe(1)
  expect(fixture.selectedJobRequests[0]).toMatchObject({
    delivery: 'follow_up',
    selectedJobPreparation: { jobId: 'fixture-selected-job-next' },
  })
  await expect(preparation.getByRole('status')).toBeVisible()
  await expect(plan).toHaveCount(0)
  await expect(draft).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('Persisted cover-letter fixture body.')

  await page.evaluate(async () => {
    const response = await fetch('/__agent_fixture__/selected-job-graph', { method: 'POST' })
    if (!response.ok) throw new Error('Could not release the second selected-job TaskGraph fixture.')
  })
  await expect.poll(() => fixture.selectedJobGraphEventSent, { timeout: 10_000 }).toBe(true)
  await expect(plan).toBeVisible({ timeout: 10_000 })
  await expect(plan).toHaveAttribute('data-agent-task-graph-revision', '5')
  await expect(plan).toContainText('Prepare Principal Engineer at Northstar Robotics')
  await expect(draft).toBeVisible({ timeout: 10_000 })
  await expect(draft).toHaveAttribute('aria-label', 'Principal Engineer · Northstar Robotics v1')
  await expect(draft).toContainText('Second selected-job cover-letter fixture body.')
  await expect(draft).toContainText('job:fixture-selected-job-next')
  await expect(draft.locator('[data-draft-source-evidence="current"]')).toContainText(isZh ? '来源版本与草稿一致。' : 'References match the current source versions.')
  await expect(draft.locator('[data-source-evidence-item="job:fixture-selected-job-next"]')).toContainText('Build principal robotics systems.')
  await expect(page.locator('body')).not.toContainText('Persisted cover-letter fixture body.')

  const composer = page.locator('.agent-composer textarea')
  await expect(composer).toBeVisible()
  await composer.fill('Keep the current draft visible.')
  await composer.press('Enter')
  await expect.poll(() => fixture.ordinaryChatRequests.length).toBe(1)
  expect(fixture.ordinaryChatRequests[0]?.content).toEqual([{ type: 'text', text: 'Keep the current draft visible.' }])
  await expect.poll(() => fixture.ordinaryChatEventSent, { timeout: 10_000 }).toBe(true)
  await expect(plan).toBeVisible()
  await expect(plan).toContainText('Prepare Principal Engineer at Northstar Robotics')
  await expect(draft).toBeVisible()
  await expect(draft).toHaveAttribute('aria-label', 'Principal Engineer · Northstar Robotics v1')
  await expect(draft).toContainText('Second selected-job cover-letter fixture body.')
})
