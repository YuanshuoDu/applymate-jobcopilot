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
})
