import { describe, expect, it } from 'vitest'

import { projectRepairTargetCheckIndexes } from './task-graph-repair-criteria'

const findingCheck = { kind: 'finding_count_gte', minimum: 1 }
const evidenceCheck = { kind: 'evidence_count_gte', minimum: 2 }

function typedNode(key: string, taskId: string, criteria: Array<{ id: string; check: unknown }>) {
  return {
    key, taskId, templateId: 'analyst', verificationDisposition: 'typed',
    verification: { schemaVersion: 'agent-harness.v2.task-graph-verification.v1', role: 'analyst', criteria },
  }
}

const target = typedNode('target', 'target-task', [
  { id: 'finding-count', check: findingCheck },
  { id: 'evidence-count', check: evidenceCheck },
])
const repair = typedNode('repair', 'repair-task', [{ id: 'evidence-count', check: evidenceCheck }])
const relation = { graphRootTaskId: 'root-task', nodeKey: 'target', taskId: 'target-task', criterionIds: ['evidence-count'] }

describe('TaskGraph repair criterion projection', () => {
  it('maps only the selected criterion to its target contract position', () => {
    const result = projectRepairTargetCheckIndexes(repair, target, relation)

    expect(result).toEqual([1])
    expect(JSON.stringify(result)).not.toMatch(/evidence-count|finding-count|taskId|root-task/)
  })

  it('fails closed for malformed, mismatched, or ambiguous repair contracts', () => {
    const invalidCases = [
      { ...relation, criterionIds: ['evidence-count', 'evidence-count'] },
      { ...relation, criterionIds: ['missing'] },
      { ...relation, extra: true },
      { ...relation, taskId: 'foreign-task' },
      { ...relation, nodeKey: 'repair' },
    ]
    for (const invalid of invalidCases) expect(projectRepairTargetCheckIndexes(repair, target, invalid)).toBeNull()

    const wrongCheck = typedNode('repair', 'repair-task', [{ id: 'evidence-count', check: { ...evidenceCheck, minimum: 3 } }])
    expect(projectRepairTargetCheckIndexes(wrongCheck, target, relation)).toBeNull()
    expect(projectRepairTargetCheckIndexes(typedNode('repair', 'repair-task', [
      { id: 'evidence-count', check: evidenceCheck }, { id: 'finding-count', check: findingCheck },
    ]), target, relation)).toBeNull()
  })
})
