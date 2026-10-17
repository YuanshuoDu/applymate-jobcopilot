import { describe, expect, it, vi } from 'vitest'
import {
  TASK_GRAPH_SCHEMA_VERSION,
  projectPlanLedger,
} from '@jobcopilot/agent-protocol'

import {
  decoratePlanLedgerRepairTargets,
  parsePlanLedgerWithRepairTargets,
  redactTaskGraphTimelineContent,
} from './task-graph-repair-display'

const sessionId = 'session-1'
const rootTaskId = 'root-1'
const verification = {
  schemaVersion: 'agent-harness.v2.task-graph-verification.v1',
  role: 'analyst',
  criteria: [{ id: 'finding-count', check: { kind: 'finding_count_gte', minimum: 1 } }],
}

function graph(repairOf?: unknown) {
  const relation = repairOf === undefined
    ? { graphRootTaskId: rootTaskId, nodeKey: 'target', taskId: 'target-task', criterionIds: ['finding-count'] }
    : repairOf
  const repair = {
    key: 'repair', templateId: 'analyst', goal: 'Repair the finding count', successCriteria: ['Return one finding'],
    dependsOn: [], depth: 1, taskId: 'repair-task', verification, verificationDisposition: 'typed',
  }
  return {
    schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
    nodes: [
      { key: 'target', templateId: 'analyst', goal: 'Find target roles', successCriteria: ['Return findings'], dependsOn: [], depth: 1, taskId: 'target-task', verification, verificationDisposition: 'typed' },
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
  it('adds only the same-root target goal from a strict repair relation', () => {
    const value = graph()
    const decorated = decoratePlanLedgerRepairTargets(ledger(value), value, rootTaskId)
    expect(decorated.nodes).toEqual([
      expect.objectContaining({ key: 'target', goal: 'Find target roles' }),
      expect.objectContaining({ key: 'repair', repairTargetGoal: 'Find target roles' }),
    ])
    expect(decorated.nodes[0]).not.toHaveProperty('repairTargetGoal')
    expect(JSON.stringify(decorated)).not.toMatch(/repairOf|criterionIds|finding-count/)
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
    expect(parsePlanLedgerWithRepairTargets(base)).toEqual(base)
    expect(parsePlanLedgerWithRepairTargets(JSON.stringify(extended))).toEqual(extended)
    expect(parsePlanLedgerWithRepairTargets({
      ...base, nodes: base.nodes.map(node => node.key === 'repair' ? { ...node, repairTargetGoal: repair.goal } : node),
    })).toBeNull()
    expect(parsePlanLedgerWithRepairTargets({
      ...base, nodes: base.nodes.map(node => node.key === 'repair' ? { ...node, repairTargetGoal: 'Unlisted goal' } : node),
    })).toBeNull()
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
