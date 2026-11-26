import { describe, expect, it } from 'vitest'

import { parsePlanLedgerTaskGraphSnapshotNodes } from './plan-ledger-package-refs.js'

function node(key: string, templateId: string, dependsOn: string[], depth: number) {
  return { key, templateId, goal: `Work for ${key}`, successCriteria: ['Complete bounded work'], dependsOn, depth, taskId: `task-${key}` }
}

function scheduledGraph(packageRefs: string[][] = [['job-a'], ['job-b']]) {
  const scouts = [node('scout-1', 'scout', [], 1), node('scout-2', 'scout', [], 1)]
  const analyst = node('analyst', 'analyst', scouts.map(item => item.key), 2)
  const prepare = { ...node('prepare', 'prepare', ['analyst'], 3), verificationDisposition: 'specialized' }
  const gate = { ...node('gate', 'gate', ['prepare'], 4), verificationDisposition: 'specialized' }
  const executes = packageRefs.map((refs, index) => ({ ...node(`execute-${index + 1}`, 'scheduled.application.execute', ['gate'], 5),
    verificationDisposition: 'specialized', packageRefs: refs }))
  const audit = { ...node('scheduled.post_gate_audit', 'scheduled.post_gate_audit', executes.map(item => item.key), 6),
    verificationDisposition: 'specialized' }
  return [...scouts, analyst, prepare, gate, ...executes, audit]
}

const VERIFICATION_VERSION = 'agent-harness.v2.task-graph-verification.v1'

function typedObjectiveScout(key: string, dependsOn: string[] = [], depth = 1) {
  return {
    ...node(key, 'scout', dependsOn, depth), verificationDisposition: 'typed',
    verification: {
      schemaVersion: VERIFICATION_VERSION, role: 'scout',
      criteria: [{ id: `${key}-count`, check: { kind: 'candidate_count_gte', minimum: 1 } }],
    },
  }
}

function objectiveSourcePrefix({
  scouts = ['scout-z', 'scout-a', 'scout-m'].map(key => typedObjectiveScout(key)),
  analystDependsOn = ['scout-z', 'scout-a', 'scout-m'],
  analystCriteria = [
    { id: 'union-membership', check: { kind: 'findings_from_scout_union', dependencyNodeKeys: ['scout-z', 'scout-a'] } },
    { id: 'union-coverage', check: { kind: 'findings_cover_scout_candidate_union_gte', dependencyNodeKeys: ['scout-a', 'scout-m'], minimumPercent: 75 } },
    { id: 'each-source', check: { kind: 'findings_cover_each_scout_candidates_gte', dependencyNodeKeys: ['scout-m', 'scout-z'], minimumPercent: 100 } },
  ],
  extraNodes = [],
}: {
  scouts?: Record<string, unknown>[]
  analystDependsOn?: string[]
  analystCriteria?: unknown[]
  extraNodes?: Record<string, unknown>[]
} = {}) {
  return [
    ...scouts,
    ...extraNodes,
    {
      ...node('analyst', 'analyst', analystDependsOn, 2), verificationDisposition: 'typed',
      verification: { schemaVersion: VERIFICATION_VERSION, role: 'analyst', criteria: analystCriteria },
    },
  ]
}

describe('Plan Ledger private TaskGraph package references', () => {
  it('accepts exact scheduled specialized nodes and strips private packageRefs from projection input', () => {
    const parsed = parsePlanLedgerTaskGraphSnapshotNodes(scheduledGraph())
    expect(parsed).toHaveLength(8)
    expect(parsed?.find(item => item.templateId === 'scheduled.application.execute')).toMatchObject({
      key: 'execute-1', taskId: 'task-execute-1', templateId: 'scheduled.application.execute',
    })
    expect(parsed?.find(item => item.templateId === 'scheduled.application.execute')).not.toHaveProperty('packageRefs')
    expect(parsed?.find(item => item.templateId === 'scheduled.post_gate_audit')).toMatchObject({ key: 'scheduled.post_gate_audit' })
  })

  it('rejects invalid Execute metadata and non-disjoint or over-cap package sets', () => {
    const base = scheduledGraph()
    const executeIndex = 5
    for (const badExecute of [
      { ...base[executeIndex]!, verificationDisposition: 'legacy_unverified' },
      { ...base[executeIndex]!, packageRefs: ['job-a', 'job-a'] },
      { ...base[executeIndex]!, packageRefs: [' job-a'] },
      { ...base[executeIndex]!, packageRefs: undefined },
      { ...base[executeIndex]!, extra: true },
      { ...base[executeIndex]!, templateId: 'scout' },
    ]) {
      expect(parsePlanLedgerTaskGraphSnapshotNodes([...base.slice(0, executeIndex), badExecute, ...base.slice(executeIndex + 1)])).toBeNull()
    }
    expect(parsePlanLedgerTaskGraphSnapshotNodes(scheduledGraph([['job-a'], ['job-a']]))).toBeNull()
    expect(parsePlanLedgerTaskGraphSnapshotNodes(scheduledGraph([[], ['job-b']]))).toBeNull()
    expect(parsePlanLedgerTaskGraphSnapshotNodes(scheduledGraph([Array.from({ length: 51 }, (_, index) => `job-${index}`)]))).toBeNull()
    expect(parsePlanLedgerTaskGraphSnapshotNodes(scheduledGraph([['a'], ['b'], ['c'], ['d']]))).toBeNull()
  })

  it('accepts an empty package partition only for the sole Execute node', () => {
    expect(parsePlanLedgerTaskGraphSnapshotNodes(scheduledGraph([[]]))).toHaveLength(7)
    expect(parsePlanLedgerTaskGraphSnapshotNodes(scheduledGraph([[], ['job-b']]))).toBeNull()
  })

  it('accepts an Objective source prefix with three typed Scouts and all union criteria', () => {
    const parsed = parsePlanLedgerTaskGraphSnapshotNodes(objectiveSourcePrefix())
    expect(parsed?.map(item => [item.key, item.templateId, item.dependsOn])).toEqual([
      ['scout-z', 'scout', []], ['scout-a', 'scout', []], ['scout-m', 'scout', []],
      ['analyst', 'analyst', ['scout-z', 'scout-a', 'scout-m']],
    ])
    expect(JSON.stringify(parsed)).not.toMatch(/verification|verificationDisposition|findings_from_scout|minimumPercent/)
  })

  it('rejects duplicate, malformed, indirect, self, unknown, untyped, and wrong-role Scout selections', () => {
    const sparseSelectors = new Array<string>(2)
    sparseSelectors[0] = 'scout-z'
    const malformed = [
      [{ kind: 'findings_from_scout_union', dependencyNodeKeys: ['scout-z', 'scout-z'] }],
      [{ kind: 'findings_from_scout_union', dependencyNodeKeys: ['scout-z'] }],
      [{ kind: 'findings_from_scout_union', dependencyNodeKeys: Array.from({ length: 9 }, (_, index) => `scout-${index}`) }],
      [{ kind: 'findings_from_scout_union', dependencyNodeKeys: sparseSelectors }],
      [{ kind: 'findings_cover_scout_candidate_union_gte', dependencyNodeKeys: ['scout-z', 'scout-a'], minimumPercent: 0 }],
      [{ kind: 'findings_cover_each_scout_candidates_gte', dependencyNodeKeys: ['scout-z', 'scout-a'], minimumPercent: 101 }],
      [{ kind: 'findings_cover_each_scout_candidates_gte', dependencyNodeKeys: ['scout-z', 'scout-a'], minimumPercent: 75.5 }],
      [{ kind: 'findings_from_scout_union', dependencyNodeKeys: ['scout-z', 'scout-a'], private: true }],
    ]
    for (const criteria of malformed) expect(parsePlanLedgerTaskGraphSnapshotNodes(objectiveSourcePrefix({ analystCriteria: criteria }))).toBeNull()

    const indirectScout = typedObjectiveScout('scout-indirect', ['scout-z'], 2)
    expect(parsePlanLedgerTaskGraphSnapshotNodes(objectiveSourcePrefix({
      extraNodes: [indirectScout],
      analystCriteria: [{ id: 'indirect', check: { kind: 'findings_from_scout_union', dependencyNodeKeys: ['scout-indirect', 'scout-a'] } }],
    }))).toBeNull()
    expect(parsePlanLedgerTaskGraphSnapshotNodes(objectiveSourcePrefix({
      analystCriteria: [{ id: 'self', check: { kind: 'findings_from_scout_union', dependencyNodeKeys: ['analyst', 'scout-a'] } }],
    }))).toBeNull()
    expect(parsePlanLedgerTaskGraphSnapshotNodes(objectiveSourcePrefix({
      analystCriteria: [{ id: 'unknown', check: { kind: 'findings_from_scout_union', dependencyNodeKeys: ['scout-missing', 'scout-a'] } }],
    }))).toBeNull()

    const { verification: _verification, ...untypedScout } = typedObjectiveScout('scout-z')
    expect(parsePlanLedgerTaskGraphSnapshotNodes(objectiveSourcePrefix({
      scouts: [{ ...untypedScout, verificationDisposition: 'legacy_unverified' }, typedObjectiveScout('scout-a'), typedObjectiveScout('scout-m')],
      analystCriteria: [{ id: 'untyped', check: { kind: 'findings_from_scout_union', dependencyNodeKeys: ['scout-z', 'scout-a'] } }],
    }))).toBeNull()

    const wrongRole = {
      ...node('analyst-source', 'analyst', [], 1), verificationDisposition: 'typed',
      verification: {
        schemaVersion: VERIFICATION_VERSION, role: 'analyst',
        criteria: [{ id: 'finding-count', check: { kind: 'finding_count_gte', minimum: 1 } }],
      },
    }
    expect(parsePlanLedgerTaskGraphSnapshotNodes(objectiveSourcePrefix({
      extraNodes: [wrongRole], analystDependsOn: ['analyst-source', 'scout-a', 'scout-m'],
      analystCriteria: [{ id: 'wrong-role', check: { kind: 'findings_from_scout_union', dependencyNodeKeys: ['analyst-source', 'scout-a'] } }],
    }))).toBeNull()
  })

  it('rejects getter-backed nested verification criteria instead of treating them as absent', () => {
    const source = objectiveSourcePrefix() as Record<string, unknown>[]
    const analyst = source[source.length - 1]!
    const verification = analyst.verification as Record<string, unknown>
    const criteria = verification.criteria
    source[source.length - 1] = {
      ...analyst,
      verification: {
        schemaVersion: VERIFICATION_VERSION,
        role: 'analyst',
        get criteria() { return criteria },
      },
    }
    expect(parsePlanLedgerTaskGraphSnapshotNodes(source)).toBeNull()
  })
})
