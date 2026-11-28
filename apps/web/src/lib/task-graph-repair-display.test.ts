import { describe, expect, it, vi } from 'vitest'
import {
  TASK_GRAPH_SCHEMA_VERSION,
  projectPlanLedger,
} from '@jobcopilot/agent-protocol'

import {
  decoratePlanLedgerRepairTargets,
  parsePlanLedgerWithRepairTargets,
  projectRepairAttentionSummaries,
  redactTaskGraphTimelineContent,
} from './task-graph-repair-display'

const sessionId = 'session-1'
const rootTaskId = 'root-1'
const targetVerification = {
  schemaVersion: 'agent-harness.v2.task-graph-verification.v1',
  role: 'analyst',
  criteria: [
    { id: 'finding-count', check: { kind: 'finding_count_gte', minimum: 1 } },
    { id: 'evidence-count', check: { kind: 'evidence_count_gte', minimum: 2 } },
  ],
}
const repairVerification = {
  schemaVersion: targetVerification.schemaVersion,
  role: targetVerification.role,
  criteria: [targetVerification.criteria[1]],
}

function graph(repairOf?: unknown) {
  const relation = repairOf === undefined
    ? { graphRootTaskId: rootTaskId, nodeKey: 'target', taskId: 'target-task', criterionIds: ['evidence-count'] }
    : repairOf
  const repair = {
    key: 'repair', templateId: 'analyst', goal: 'Repair the finding count', successCriteria: ['Return one finding'],
    dependsOn: [], depth: 1, taskId: 'repair-task', verification: repairVerification, verificationDisposition: 'typed',
  }
  return {
    schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
    nodes: [
      { key: 'target', templateId: 'analyst', goal: 'Find target roles', successCriteria: ['Return findings'], dependsOn: [], depth: 1, taskId: 'target-task', verification: targetVerification, verificationDisposition: 'typed' },
      ...(relation === null ? [repair] : [{ ...repair, repairOf: relation }]),
    ],
  }
}

function ledger(rawGraph: unknown = graph()) {
  const value = projectPlanLedger({
    sessionId, revision: 3, rootTaskId, graph: rawGraph,
    tasks: [
      { id: rootTaskId, sessionId, status: 'running', goal: 'Review open roles', hasResult: false },
      { id: 'target-task', sessionId, status: 'failed', role: 'analyst', goal: 'Find target roles', result: null },
      { id: 'repair-task', sessionId, status: 'queued', role: 'analyst', goal: 'Repair the finding count', result: null },
    ],
  })
  if (!value) throw new Error('fixture PlanLedger did not parse')
  return value
}

describe('TaskGraph repair display projection', () => {
  it('adds only the same-root target goal and selected check positions from a strict repair relation', () => {
    const value = graph()
    const base = ledger(value)
    const inputSnapshot = JSON.stringify({ base, value })
    const decorated = decoratePlanLedgerRepairTargets(base, value, rootTaskId)
    expect(decorated.nodes).toEqual([
      expect.objectContaining({ key: 'target', goal: 'Find target roles' }),
      expect.objectContaining({ key: 'repair', repairTargetGoal: 'Find target roles', repairTargetNodeIndex: 0, repairTargetCheckIndexes: [1] }),
    ])
    expect(JSON.stringify({ base, value })).toBe(inputSnapshot)
    expect(decorated.nodes[0]).not.toHaveProperty('repairTargetGoal')
    expect(parsePlanLedgerWithRepairTargets(decorated)).toEqual(decorated)
    expect(JSON.stringify(decorated)).not.toMatch(/repairOf|criterionIds|finding-count/)
  })

  it('keeps legacy target text but suppresses check causality for a forward repair relation', () => {
    const baseGraph = graph()
    const forwardGraph = { ...baseGraph, nodes: [baseGraph.nodes[1]!, baseGraph.nodes[0]!] }
    const base = ledger(forwardGraph)
    const decorated = decoratePlanLedgerRepairTargets(base, forwardGraph, rootTaskId)
    expect(decorated.nodes[0]).toMatchObject({ repairTargetGoal: 'Find target roles', repairTargetNodeIndex: 1 })
    expect(decorated.nodes[0]).not.toHaveProperty('repairTargetCheckIndexes')
    expect(parsePlanLedgerWithRepairTargets(decorated)).toEqual(decorated)

    const invalid = {
      ...decorated,
      nodes: decorated.nodes.map((node, index) => index === 0
        ? { ...node, repairTargetCheckIndexes: [1] } : node),
    }
    expect(parsePlanLedgerWithRepairTargets(invalid)).toBeNull()
    expect(projectRepairAttentionSummaries(invalid, {
      schemaVersion: 1,
      nodes: [null, { status: 'failed', checks: [
        { kind: 'finding_count_gte', minimum: 1, status: 'passed' },
        { kind: 'evidence_count_gte', minimum: 2, status: 'failed' },
      ], totalCount: 2, passedCount: 1, failedCount: 1, unverifiedCount: 0 }],
    })).toEqual([null, null])
  })

  it('binds duplicate public goal text to the strictly matched target index', () => {
    const baseGraph = graph()
    const duplicateGraph = {
      ...baseGraph,
      nodes: [
        baseGraph.nodes[0],
        { ...baseGraph.nodes[0], key: 'other-target', taskId: 'other-task' },
        baseGraph.nodes[1],
      ],
    }
    const decorated = decoratePlanLedgerRepairTargets(ledger(duplicateGraph), duplicateGraph, rootTaskId)
    const repair = decorated.nodes.find(node => node.key === 'repair')

    expect(decorated.nodes.filter(node => node.goal === 'Find target roles')).toHaveLength(2)
    expect(repair).toMatchObject({ repairTargetGoal: 'Find target roles', repairTargetNodeIndex: 0, repairTargetCheckIndexes: [1] })
    expect(parsePlanLedgerWithRepairTargets(decorated)?.nodes.find(node => node.key === 'repair')).toMatchObject({ repairTargetNodeIndex: 0 })
  })

  it('omits labels for missing root, wrong root, wrong target identity, self and legacy relations', () => {
    const base = ledger()
    const cases = [
      [graph(), null],
      [graph({ graphRootTaskId: 'foreign-root', nodeKey: 'target', taskId: 'target-task', criterionIds: ['finding-count'] }), rootTaskId],
      [graph({ graphRootTaskId: rootTaskId, nodeKey: 'target', taskId: 'other-task', criterionIds: ['finding-count'] }), rootTaskId],
      [graph({ graphRootTaskId: rootTaskId, nodeKey: 'repair', taskId: 'repair-task', criterionIds: ['finding-count'] }), rootTaskId],
      [graph(null), rootTaskId],
    ] as const
    for (const [raw, trustedRoot] of cases) {
      const projected = decoratePlanLedgerRepairTargets(base, raw, trustedRoot)
      expect(projected.nodes.some(node => 'repairTargetGoal' in node)).toBe(false)
      expect(projected.nodes.some(node => 'repairTargetNodeIndex' in node)).toBe(false)
    }
  })

  it('fails closed on malformed snapshots and does not decorate a legacy base graph', () => {
    const base = ledger()
    expect(decoratePlanLedgerRepairTargets(base, { ...graph(), private: 'raw' }, rootTaskId)).toEqual(base)
    expect(decoratePlanLedgerRepairTargets(base, { schemaVersion: 'future', nodes: [] }, rootTaskId)).toEqual(base)
  })

  it('parses old payloads and only reattaches an optional goal matching another safe node', () => {
    const base = ledger()
    const repair = base.nodes.find(node => node.key === 'repair')!
    const target = base.nodes.find(node => node.key === 'target')!
    const extended = {
      ...base,
      nodes: base.nodes.map(node => node.key === 'repair' ? { ...node, repairTargetGoal: target.goal } : node),
    }
    const indexed = {
      ...base,
      nodes: base.nodes.map(node => node.key === 'repair' ? {
        ...node, repairTargetGoal: target.goal, repairTargetNodeIndex: 0, repairTargetCheckIndexes: [1],
      } : node),
    }
    expect(parsePlanLedgerWithRepairTargets(base)).toEqual(base)
    expect(parsePlanLedgerWithRepairTargets(JSON.stringify(extended))).toEqual(extended)
    expect(parsePlanLedgerWithRepairTargets(indexed)).toEqual(indexed)
    expect(parsePlanLedgerWithRepairTargets({
      ...base, nodes: base.nodes.map(node => node.key === 'repair' ? { ...node, repairTargetGoal: repair.goal } : node),
    })).toBeNull()
    expect(parsePlanLedgerWithRepairTargets({
      ...base, nodes: base.nodes.map(node => node.key === 'repair' ? { ...node, repairTargetGoal: 'Unlisted goal' } : node),
    })).toBeNull()
    expect(parsePlanLedgerWithRepairTargets({
      ...base, nodes: base.nodes.map(node => node.key === 'repair' ? { ...node, repairTargetGoal: target.goal, repairTargetNodeIndex: 1 } : node),
    })).toBeNull()
    expect(parsePlanLedgerWithRepairTargets({
      ...base, nodes: base.nodes.map(node => node.key === 'repair' ? { ...node, repairTargetGoal: target.goal, repairTargetNodeIndex: 8 } : node),
    })).toBeNull()
    expect(parsePlanLedgerWithRepairTargets({
      ...base, nodes: base.nodes.map(node => node.key === 'repair' ? { ...node, repairTargetGoal: 'Different goal', repairTargetNodeIndex: 0 } : node),
    })).toBeNull()
    for (const invalidIndexes of [[], [1, 1], [1, 0], [8], ['1'], [null]]) {
      expect(parsePlanLedgerWithRepairTargets({
        ...base, nodes: base.nodes.map(node => node.key === 'repair' ? {
          ...node, repairTargetGoal: target.goal, repairTargetNodeIndex: 0, repairTargetCheckIndexes: invalidIndexes,
        } : node),
      })).toBeNull()
    }
  })

  it('projects only failed or unverified checks from the indexed target', () => {
    const projection = decoratePlanLedgerRepairTargets(ledger(), graph(), rootTaskId)
    const failedSummary = {
      schemaVersion: 1 as const,
      nodes: [
        { status: 'failed' as const, checks: [
          { kind: 'finding_count_gte' as const, minimum: 1, status: 'failed' as const },
          { kind: 'evidence_count_gte' as const, minimum: 2, status: 'failed' as const },
        ], totalCount: 2, passedCount: 0, failedCount: 2, unverifiedCount: 0 },
        null,
      ],
    }
    const summarySnapshot = JSON.stringify(failedSummary)
    const failed = projectRepairAttentionSummaries(projection, failedSummary)
    expect(failed[1]).toEqual({ status: 'failed', checks: [
      { kind: 'evidence_count_gte', minimum: 2, status: 'failed' },
    ], totalCount: 1, passedCount: 0, failedCount: 1, unverifiedCount: 0 })
    expect(JSON.stringify(failed)).not.toMatch(/criterionIds|finding-count|taskId|rootTaskId/)
    expect(JSON.stringify(failedSummary)).toBe(summarySnapshot)

    const unverifiedSummary = {
      schemaVersion: 1 as const,
      nodes: [
        { status: 'unverified' as const, checks: [
          { kind: 'finding_count_gte' as const, minimum: 1, status: 'unverified' as const },
          { kind: 'evidence_count_gte' as const, minimum: 2, status: 'unverified' as const },
        ], totalCount: 2, passedCount: 0, failedCount: 0, unverifiedCount: 2 },
        null,
      ],
    }
    expect(projectRepairAttentionSummaries(projection, unverifiedSummary)[1]).toEqual({
      status: 'unverified', checks: [{ kind: 'evidence_count_gte', minimum: 2, status: 'unverified' }],
      totalCount: 1, passedCount: 0, failedCount: 0, unverifiedCount: 1,
    })
    expect(projectRepairAttentionSummaries(projection, {
      schemaVersion: 1, nodes: [{ status: 'passed', checks: [
        { kind: 'finding_count_gte', minimum: 1, status: 'passed' },
        { kind: 'evidence_count_gte', minimum: 2, status: 'passed' },
      ], totalCount: 2, passedCount: 2, failedCount: 0, unverifiedCount: 0 }, null],
    })[1]).toBeNull()
    expect(projectRepairAttentionSummaries(projection, {
      schemaVersion: 1, nodes: [{ status: 'failed', checks: [
        { kind: 'finding_count_gte', minimum: 1, status: 'failed' },
        { kind: 'evidence_count_gte', minimum: 2, status: 'passed' },
      ], totalCount: 2, passedCount: 1, failedCount: 1, unverifiedCount: 0 }, null],
    })[1]).toBeNull()
    expect(projectRepairAttentionSummaries(projection, {
      schemaVersion: 1, nodes: [{ status: 'failed', checks: [
        { kind: 'evidence_count_gte', minimum: 2, status: 'failed' },
      ], totalCount: 1, passedCount: 0, failedCount: 1, unverifiedCount: 0 }, null],
    })[1]).toBeNull()
    expect(projectRepairAttentionSummaries(projection, { schemaVersion: 1, nodes: [{ status: 'unavailable' }, null] })[1]).toBeNull()
    expect(projectRepairAttentionSummaries(projection, { schemaVersion: 1, nodes: [null] })[1]).toBeNull()
    expect(projectRepairAttentionSummaries(projection, null)).toEqual([null, null])

    const legacy = parsePlanLedgerWithRepairTargets({
      ...ledger(), nodes: ledger().nodes.map(node => node.key === 'repair' ? { ...node, repairTargetGoal: 'Find target roles' } : node),
    })!
    expect(projectRepairAttentionSummaries(legacy, failedSummary)[1]).toBeNull()
  })

  it('retains strict rejection of unknown display fields', () => {
    const base = ledger()
    const repair = base.nodes.find(node => node.key === 'repair')!
    expect(parsePlanLedgerWithRepairTargets({
      ...base, nodes: base.nodes.map(node => node.key === 'repair' ? { ...node, repairTargetGoal: 'Find target roles', private: 'secret' } : node),
    })).toBeNull()
    expect(parsePlanLedgerWithRepairTargets({ ...base, private: 'secret' })).toBeNull()
  })

  it('projects strict timeline snapshots and strips repair and verification metadata', () => {
    const privateGraph = graph()
    const redact = vi.fn((value: unknown) => typeof value === 'string' ? value.replace('TOKEN', '[REDACTED]') : value)
    const result = redactTaskGraphTimelineContent('task_graph', {
      ...privateGraph,
      nodes: privateGraph.nodes.map(node => ({ ...node, goal: node.key === 'target' ? 'TOKEN target roles' : node.goal })),
    }, redact)
    expect(result).toEqual({
      schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
      nodes: [
        { key: 'target', templateId: 'analyst', goal: '[REDACTED] target roles', successCriteria: ['Return findings'], dependsOn: [], depth: 1, taskId: 'target-task' },
        { key: 'repair', templateId: 'analyst', goal: 'Repair the finding count', successCriteria: ['Return one finding'], dependsOn: [], depth: 1, taskId: 'repair-task' },
      ],
    })
    expect(JSON.stringify(result)).not.toMatch(/verification|repairOf|repairReceipt|finding-count/)
  })

  it('projects only a bounded hint for a valid marked wave snapshot', () => {
    const scout = { key: 'scout', taskId: 'scout-task', templateId: 'scout', goal: 'Private source goal', successCriteria: ['Private criterion'],
      dependsOn: [], depth: 1, verification: { schemaVersion: 'agent-harness.v2.task-graph-verification.v1', role: 'scout',
        criteria: [{ id: 'candidate-count', check: { kind: 'candidate_count_gte', minimum: 1 } }] }, verificationDisposition: 'typed' }
    const analyst = { key: 'analyst', taskId: 'analyst-task', templateId: 'analyst', goal: 'Private analysis goal', successCriteria: ['Private criterion'],
      dependsOn: ['scout'], depth: 2, verification: { schemaVersion: 'agent-harness.v2.task-graph-verification.v1', role: 'analyst',
        criteria: [{ id: 'finding-count', check: { kind: 'finding_count_gte', minimum: 1 } }] }, verificationDisposition: 'typed' }
    const writer = { key: 'writer', taskId: 'writer-task', templateId: 'cover_letter_writer', goal: 'Private draft goal', successCriteria: ['Private criterion'],
      dependsOn: ['analyst'], depth: 3, verificationDisposition: 'specialized' }
    const reviewer = { key: 'reviewer', taskId: 'reviewer-task', templateId: 'cover_letter_reviewer', goal: 'Private review goal', successCriteria: ['Private criterion'],
      dependsOn: ['writer'], depth: 4, verificationDisposition: 'specialized' }
    const marked = { schemaVersion: 'agent-harness.v2.task-graph', nodes: [scout, analyst, writer, reviewer], objectiveTailor: {
      schemaVersion: 'agent-harness.v2.objective-tailor-graph.v1', sourceNodeCount: 2, slots: [
        { slotId: 'tailor-1', sourceAnalystNodeKey: 'analyst', writerNodeKey: 'writer', reviewerNodeKey: 'reviewer' },
      ],
    } }
    const redact = vi.fn((value: unknown) => value)
    const projected = redactTaskGraphTimelineContent('task_graph', marked, redact)
    expect(projected).toEqual({ objectiveTailorProgressHint: {
      schemaVersion: 'agent-harness.v2.objective-tailor-progress-hint.v1', sourceNodeCount: 2, slotCount: 1,
    } })
    expect(redact).not.toHaveBeenCalled()
    expect(JSON.stringify(projected)).not.toMatch(/Private|taskId|graphItemId|sourceAnalystNodeKey|writer-task/)
  })

  it('returns null for malformed task graphs and delegates other item types unchanged', () => {
    const redact = vi.fn((value: unknown) => ({ wrapped: value }))
    expect(redactTaskGraphTimelineContent('task_graph', { ...graph(), nodes: [{ ...graph().nodes[0], taskGraphRepairReceipt: { secret: true } }] }, redact)).toBeNull()
    const content = { nested: { answer: 'original' } }
    const sentinel = { redacted: true }
    const delegate = vi.fn(() => sentinel)
    expect(redactTaskGraphTimelineContent('agent_message', content, delegate)).toBe(sentinel)
    expect(delegate).toHaveBeenCalledExactlyOnceWith(content)
    expect(redact).not.toHaveBeenCalled()
  })
})
