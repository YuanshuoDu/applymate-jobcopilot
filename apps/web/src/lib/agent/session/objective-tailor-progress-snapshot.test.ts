import { describe, expect, it } from 'vitest'
import { objectiveTailorProgressHint, parseObjectiveTailorProgressSnapshot } from './objective-tailor-progress-snapshot'

const verification = (role: 'scout' | 'analyst') => ({ schemaVersion: 'agent-harness.v2.task-graph-verification.v1', role,
  criteria: [{ id: role === 'scout' ? 'candidate-count' : 'finding-count',
    check: { kind: role === 'scout' ? 'candidate_count_gte' : 'finding_count_gte', minimum: 1 } }] })
function markedSnapshot(sourceCount = 2, slotCount = 1) {
  const sources = Array.from({ length: sourceCount }, (_, index) => {
    const role = index === 0 ? 'scout' : 'analyst'
    return { key: `${role}-${index}`, taskId: `task-${role}-${index}`, templateId: role, goal: 'Source work',
      successCriteria: ['Return typed evidence'], dependsOn: index ? ['scout-0'] : [], depth: index + 1,
      verification: verification(role), verificationDisposition: 'typed' }
  })
  const analysts = sources.filter(node => node.templateId === 'analyst')
  const slots = Array.from({ length: slotCount }, (_, index) => ({ slotId: `tailor-${index + 1}`,
    sourceAnalystNodeKey: analysts[index % analysts.length]!.key, writerNodeKey: `writer-${index + 1}`, reviewerNodeKey: `reviewer-${index + 1}` }))
  const nodes = [...sources, ...slots.flatMap(slot => [
    { key: slot.writerNodeKey, taskId: `task-${slot.writerNodeKey}`, templateId: 'cover_letter_writer', goal: 'Draft',
      successCriteria: ['Write a draft'], dependsOn: [slot.sourceAnalystNodeKey], depth: 3, verificationDisposition: 'specialized' },
    { key: slot.reviewerNodeKey, taskId: `task-${slot.reviewerNodeKey}`, templateId: 'cover_letter_reviewer', goal: 'Review',
      successCriteria: ['Review the draft'], dependsOn: [slot.writerNodeKey], depth: 4, verificationDisposition: 'specialized' },
  ])]
  return { schemaVersion: 'agent-harness.v2.task-graph', nodes,
    objectiveTailor: { schemaVersion: 'agent-harness.v2.objective-tailor-graph.v1', sourceNodeCount: sourceCount, slots } }
}

describe('objective tailor progress snapshot', () => {
  it('projects only identities from the exact marked snapshot and accepts the full 23-node wave shape', () => {
    const snapshot = markedSnapshot(7, 8)
    expect(snapshot.nodes).toHaveLength(23)
    const parsed = parseObjectiveTailorProgressSnapshot(snapshot)
    expect(parsed?.nodes).toHaveLength(23)
    expect(parsed?.marker.sourceNodeCount).toBe(7)
    expect(objectiveTailorProgressHint(parsed!)).toEqual({ schemaVersion: 'agent-harness.v2.objective-tailor-progress-hint.v1', sourceNodeCount: 7, slotCount: 8 })
    expect(parsed?.nodes[0]).toEqual({ key: 'scout-0', taskId: 'task-scout-0', templateId: 'scout' })
    expect(JSON.stringify(parsed)).not.toMatch(/goal|successCriteria|verification|jobId|artifact|digest/)
  })

  it('rejects malformed, oversized, ambiguous, or extended persisted snapshots', () => {
    const snapshot = markedSnapshot()
    expect(parseObjectiveTailorProgressSnapshot({ ...snapshot, privateProof: 'secret' })).toBeUndefined()
    expect(parseObjectiveTailorProgressSnapshot({ ...snapshot, nodes: snapshot.nodes.map((node, index) => index ? node : { ...node, extra: 'secret' }) })).toBeUndefined()
    expect(parseObjectiveTailorProgressSnapshot({ ...snapshot, nodes: snapshot.nodes.map((node, index) => index ? node : { ...node, taskId: snapshot.nodes[1]!.taskId }) })).toBeUndefined()
    expect(parseObjectiveTailorProgressSnapshot({ ...snapshot, objectiveTailor: { ...snapshot.objectiveTailor, slots: [] } })).toBeUndefined()
    expect(parseObjectiveTailorProgressSnapshot({ ...snapshot, nodes: [...snapshot.nodes, ...snapshot.nodes.slice(0, 40)] })).toBeUndefined()
    const accessor = Object.defineProperty({ ...snapshot }, 'objectiveTailor', { enumerable: true, get: () => snapshot.objectiveTailor })
    expect(parseObjectiveTailorProgressSnapshot(accessor)).toBeUndefined()
  })
})
