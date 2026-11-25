import { beforeEach, describe, expect, it, vi } from 'vitest'

import { canonicalTaskGraphItemId, canonicalTaskGraphSourceKey } from '@/lib/agent/session/final-task-graph-source-detail'

const mocks = vi.hoisted(() => {
  const tenant = { userId: null as string | null }
  return {
    tenant,
    requireAuth: vi.fn(), sessionFindFirst: vi.fn(), finalItemFindFirst: vi.fn(), turnFindFirst: vi.fn(), graphFindMany: vi.fn(), taskFindMany: vi.fn(),
    runWithTenantContext: vi.fn(async (userId: string, callback: () => Promise<unknown>) => {
      tenant.userId = userId
      try { return await callback() } finally { tenant.userId = null }
    }),
  }
})

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (value: unknown) => Response.json(value),
}))
vi.mock('@/lib/db', () => ({ db: {
  agentSession: { findFirst: mocks.sessionFindFirst }, agentItem: { findFirst: mocks.finalItemFindFirst, findMany: mocks.graphFindMany },
  agentTurn: { findFirst: mocks.turnFindFirst }, subAgentTask: { findMany: mocks.taskFindMany },
} }))
vi.mock('@/lib/db/tenant-store', () => ({ runWithTenantContext: mocks.runWithTenantContext }))

const sessionId = 'session_1', itemId = 'final_1', turnId = 'turn_1', rootTaskId = 'root_1'
const sourceKey = canonicalTaskGraphSourceKey(itemId, 4, 0)
const params = { params: Promise.resolve({ id: sessionId, itemId, sourceKey }) }

function request() { return new Request(`http://localhost/api/agent/sessions/${sessionId}/final-items/${itemId}/task-graph-sources/${sourceKey}`) }

function objectiveFixture() {
  const sourceNodes = [
    { key: 'wave-scout', templateId: 'scout', goal: 'Find roles', successCriteria: ['Return evidence'], dependsOn: [], depth: 1,
      taskId: 'wave-scout-task', verification: { schemaVersion: 'agent-harness.v2.task-graph-verification.v1', role: 'scout',
        criteria: [{ id: 'candidate-count', check: { kind: 'candidate_count_gte', minimum: 1 } }] }, verificationDisposition: 'typed' },
    { key: 'wave-analyst', templateId: 'analyst', goal: 'Assess roles', successCriteria: ['Return evidence'], dependsOn: ['wave-scout'], depth: 2,
      taskId: 'wave-analyst-task', verification: { schemaVersion: 'agent-harness.v2.task-graph-verification.v1', role: 'analyst',
        criteria: [{ id: 'finding-count', check: { kind: 'finding_count_gte', minimum: 1 } }] }, verificationDisposition: 'typed' },
  ]
  const slots = Array.from({ length: 8 }, (_, index) => ({ slotId: `tailor-${index + 1}`,
    sourceAnalystNodeKey: 'wave-analyst', writerNodeKey: `wave-writer-${index + 1}`, reviewerNodeKey: `wave-reviewer-${index + 1}` }))
  const suffix = slots.flatMap(slot => [
    { key: slot.writerNodeKey, templateId: 'cover_letter_writer', goal: 'Draft material', successCriteria: ['Use evidence'],
      dependsOn: [slot.sourceAnalystNodeKey], depth: 3, taskId: `task-${slot.writerNodeKey}`, verificationDisposition: 'specialized' },
    { key: slot.reviewerNodeKey, templateId: 'cover_letter_reviewer', goal: 'Review material', successCriteria: ['Check material'],
      dependsOn: [slot.writerNodeKey], depth: 4, taskId: `task-${slot.reviewerNodeKey}`, verificationDisposition: 'specialized' },
  ])
  const graph = { schemaVersion: 'agent-harness.v2.task-graph', rootSuccessCriteria: ['Complete the Objective'],
    nodes: [...sourceNodes, ...suffix], objectiveTailor: {
      schemaVersion: 'agent-harness.v2.objective-tailor-graph.v1', sourceNodeCount: sourceNodes.length, slots,
    } }
  const sources = sourceNodes.map((node, nodeIndex) => ({ sourceKey: canonicalTaskGraphSourceKey(itemId, 4, nodeIndex), nodeIndex,
    role: node.templateId, taskStatus: 'completed', resultState: 'valid', roleResultStatus: 'completed' }))
  const finalContent = { text: 'Verified source answer', final: { schemaVersion: 'agent-harness.v2.final', response: 'Verified source answer' },
    taskGraphSources: { schemaVersion: 'agent-harness.v2.task-graph-sources.v1', graphRevision: 4, sources },
    objectiveTailorFinalOutcomes: { schemaVersion: 'agent-harness.v2.objective-tailor-final-outcomes.v1',
      slots: slots.map((_, index) => ({ ordinal: index + 1, status: 'ready' })) } }
  const jobId = 'source-job-1'
  const childResult = (role: 'scout' | 'analyst') => {
    const evidenceId = `${role}-job-evidence`
    const structuredResult = role === 'scout'
      ? { schemaVersion: 'agent-harness.v2.subagent.result', role, status: 'completed', summary: 'Found roles',
        candidates: [{ jobId, source: 'greenhouse', url: 'https://jobs.example/1', evidenceIds: [evidenceId] }],
        evidence: [{ id: evidenceId, kind: 'job', ref: jobId, source: 'greenhouse' }] }
      : { schemaVersion: 'agent-harness.v2.subagent.result', role, status: 'completed', summary: 'Assessed roles',
        findings: [{ jobId, score: 8, evidenceIds: [evidenceId] }], evidence: [{ id: evidenceId, kind: 'job', ref: jobId, source: 'greenhouse' }] }
    return { status: 'completed', stepCount: 1, toolCallCount: 1, finalItemId: `private-${role}-final`, finalText: 'Private model text', structuredResult }
  }
  const updatedAt = new Date('2026-10-01T00:00:00Z')
  const tasks = [
    { id: rootTaskId, sessionId, turnId, rootTaskId, parentTaskId: null, role: 'orchestrator', taskType: 'root',
      status: 'completed', goal: 'Research roles', result: null, updatedAt },
    { id: 'wave-scout-task', sessionId, turnId, rootTaskId, parentTaskId: rootTaskId, role: 'scout', taskType: 'job_discovery',
      status: 'completed', goal: 'Find roles', result: childResult('scout'), updatedAt },
    { id: 'wave-analyst-task', sessionId, turnId, rootTaskId, parentTaskId: rootTaskId, role: 'analyst', taskType: 'job_analysis',
      status: 'completed', goal: 'Assess roles', result: childResult('analyst'), updatedAt },
  ]
  return { graph, finalContent, tasks, analystKey: canonicalTaskGraphSourceKey(itemId, 4, 1) }
}

describe('final TaskGraph source detail API', () => {
  beforeEach(() => {
    vi.resetModules()
    for (const mock of [mocks.requireAuth, mocks.sessionFindFirst, mocks.finalItemFindFirst, mocks.turnFindFirst, mocks.graphFindMany, mocks.taskFindMany]) mock.mockReset()
    mocks.runWithTenantContext.mockClear(); mocks.tenant.userId = null
    mocks.requireAuth.mockResolvedValue({ userId: 'user_1' })
    mocks.sessionFindFirst.mockResolvedValue({ id: sessionId, userId: 'user_1' })
    mocks.finalItemFindFirst.mockResolvedValue({
      id: itemId, sessionId, turnId, taskId: rootTaskId, type: 'agent_message', status: 'completed', phase: 'final_answer',
      content: { taskGraphSources: { schemaVersion: 'agent-harness.v2.task-graph-sources.v1', graphRevision: 4, sources: [
        { sourceKey, nodeIndex: 0, role: 'scout', taskStatus: 'completed', resultState: 'valid', roleResultStatus: 'completed' },
      ] } },
    })
    mocks.turnFindFirst.mockResolvedValue({ id: turnId, sessionId, userId: 'user_1', status: 'completed', rootTaskId })
    mocks.graphFindMany.mockResolvedValue([{
      id: canonicalTaskGraphItemId(rootTaskId), sessionId, turnId, taskId: rootTaskId, type: 'task_graph', revision: 4,
      content: { schemaVersion: 'agent-harness.v2.task-graph', nodes: [
        { key: 'scout', templateId: 'scout', goal: 'Find roles', successCriteria: ['Collect evidence'], dependsOn: [], depth: 1, taskId: 'child_1' },
      ] },
    }])
    const updatedAt = new Date('2026-10-01T00:00:00Z')
    mocks.taskFindMany.mockResolvedValue([
      { id: rootTaskId, sessionId, turnId, rootTaskId, parentTaskId: null, role: 'orchestrator', taskType: 'root', status: 'completed', goal: 'Research roles', result: null, attemptCount: 1, updatedAt },
      { id: 'child_1', sessionId, turnId, rootTaskId, parentTaskId: rootTaskId, role: 'scout', taskType: 'scout', status: 'completed',
        goal: 'Find roles for alex@example.test', result: { status: 'completed', structuredResult: { role: 'scout', status: 'completed', secret: 'PRIVATE_RAW_RESULT' }, finalText: 'PRIVATE_FINAL_TEXT' }, attemptCount: 1, updatedAt },
    ])
  })

  it('returns only a bounded same-owner detail and keeps all database reads in tenant context', async () => {
    const { GET } = await import('./route')
    const response = await GET(request() as never, params)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(body.task).toMatchObject({ role: 'scout', taskStatus: 'completed', resultState: 'valid', roleResultStatus: 'completed' })
    expect(body.task.goal).toContain('[redacted]')
    expect(body.task.verification).toEqual({ status: 'unavailable' })
    expect(mocks.runWithTenantContext).toHaveBeenCalledWith('user_1', expect.any(Function))
    expect(mocks.sessionFindFirst).toHaveBeenCalledWith({ where: { id: sessionId, userId: 'user_1' }, select: { id: true, userId: true } })
    expect(mocks.finalItemFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: itemId, sessionId, type: 'agent_message', status: 'completed', phase: 'final_answer' },
    }))
    expect(mocks.turnFindFirst).toHaveBeenCalledWith({ where: { id: turnId, sessionId, userId: 'user_1' }, select: { id: true, sessionId: true, userId: true, status: true, rootTaskId: true } })
    expect(mocks.taskFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId, turnId, rootTaskId, id: { in: [rootTaskId, 'child_1'] } }, take: 3,
    }))
    expect(mocks.graphFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: canonicalTaskGraphItemId(rootTaskId), sessionId, turnId, taskId: rootTaskId,
        type: 'task_graph', revision: 4 },
    }))
    const serialized = JSON.stringify(body)
    for (const privateValue of ['user_1', sessionId, turnId, rootTaskId, 'child_1', canonicalTaskGraphItemId(rootTaskId), 'PRIVATE_RAW_RESULT', 'PRIVATE_FINAL_TEXT', 'alex@example.test']) {
      expect(serialized).not.toContain(privateValue)
    }
  })

  it('returns one generic unavailable response for wrong owner, stale graph, or noncanonical source', async () => {
    const { GET } = await import('./route')
    mocks.sessionFindFirst.mockResolvedValueOnce(null)
    const wrongOwner = await GET(request() as never, params)
    expect(wrongOwner.status).toBe(404)
    expect(mocks.finalItemFindFirst).not.toHaveBeenCalled()

    mocks.graphFindMany.mockResolvedValueOnce([])
    const staleGraph = await GET(request() as never, params)
    expect(staleGraph.status).toBe(404)

    const invalidParams = { params: Promise.resolve({ id: sessionId, itemId, sourceKey: `src_${'B'.repeat(43)}` }) }
    const invalidSource = await GET(request() as never, invalidParams)
    expect(invalidSource.status).toBe(404)
    for (const response of [wrongOwner, staleGraph, invalidSource]) {
      const serialized = await response.text()
      expect(serialized).toContain('task_graph_source_unavailable')
      expect(serialized).not.toContain(sessionId)
      expect(serialized).not.toContain('child_1')
    }
  })

  it('rejects a graph row whose item ID is not canonical for the root task', async () => {
    mocks.graphFindMany.mockResolvedValueOnce([{
      id: `task-graph-${'0'.repeat(64)}`, sessionId, turnId, taskId: rootTaskId, type: 'task_graph', revision: 4,
      content: { schemaVersion: 'agent-harness.v2.task-graph', nodes: [
        { key: 'scout', templateId: 'scout', goal: 'Find roles', successCriteria: ['Collect evidence'], dependsOn: [], depth: 1, taskId: 'child_1' },
      ] },
    }])
    const { GET } = await import('./route')
    const response = await GET(request() as never, params)
    expect(response.status).toBe(404)
  })

  it('resolves an authenticated Objective source from the bounded prefix of a larger graph', async () => {
    const fixture = objectiveFixture()
    mocks.finalItemFindFirst.mockResolvedValue({
      id: itemId, sessionId, turnId, taskId: rootTaskId, type: 'agent_message', status: 'completed', phase: 'final_answer', content: fixture.finalContent,
    })
    mocks.graphFindMany.mockResolvedValue([{
      id: canonicalTaskGraphItemId(rootTaskId), sessionId, turnId, taskId: rootTaskId, type: 'task_graph', revision: 4, content: fixture.graph,
    }])
    mocks.taskFindMany.mockResolvedValue(fixture.tasks)
    const { GET } = await import('./route')
    const response = await GET(request() as never, { params: Promise.resolve({ id: sessionId, itemId, sourceKey: fixture.analystKey }) })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.task).toMatchObject({ role: 'analyst', taskStatus: 'completed', resultState: 'valid', roleResultStatus: 'completed' })
    expect(mocks.taskFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId, turnId, rootTaskId, id: { in: [rootTaskId, 'wave-scout-task', 'wave-analyst-task'] } }, take: 4,
    }))
    expect(JSON.stringify(body)).not.toContain('task-wave-writer-1')
  })

  it('does not query protected data when authentication fails', async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    const { GET } = await import('./route')
    const response = await GET(request() as never, params)
    expect(response.status).toBe(401)
    expect(mocks.runWithTenantContext).not.toHaveBeenCalled()
    expect(mocks.sessionFindFirst).not.toHaveBeenCalled()
    expect(mocks.taskFindMany).not.toHaveBeenCalled()
  })
})
