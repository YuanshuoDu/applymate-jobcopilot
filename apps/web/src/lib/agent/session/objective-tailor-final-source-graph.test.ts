import { describe, expect, it } from 'vitest'
import { parseTaskGraphSnapshot } from '@jobcopilot/agent-protocol'
import { readFinalTaskGraphSourceSnapshot } from './objective-tailor-final-source-graph'

const graphSchema = 'agent-harness.v2.task-graph'
const markerSchema = 'agent-harness.v2.objective-tailor-graph.v1'
const sidecarSchema = 'agent-harness.v2.objective-tailor-final-outcomes.v1'
type GraphNode = Record<string, unknown>
type Slot = { slotId: string; sourceAnalystNodeKey: string; writerNodeKey: string; reviewerNodeKey: string;
  correction?: { writerNodeKey: string; reviewerNodeKey: string } }

function verification(role: 'scout' | 'analyst') {
  const scout = role === 'scout'
  return { schemaVersion: 'agent-harness.v2.task-graph-verification.v1', role,
    criteria: [{ id: scout ? 'candidate-count' : 'finding-count',
      check: { kind: scout ? 'candidate_count_gte' : 'finding_count_gte', minimum: 1 } }] }
}

function wave(corrections: readonly number[] = [2, 7]) {
  const sources: GraphNode[] = Array.from({ length: 7 }, (_, index) => {
    const role = index < 3 ? 'scout' : 'analyst'
    return { key: 'source-' + (index + 1), taskId: 'task-source-' + (index + 1), templateId: role,
      goal: 'Read current evidence', successCriteria: ['Return typed findings'],
      dependsOn: index < 3 ? (index ? ['source-' + index] : []) : ['source-' + (index - 2)],
      depth: index < 3 ? 1 : 2, verification: verification(role), verificationDisposition: 'typed' }
  })
  const analysts = sources.filter(node => node.templateId === 'analyst')
  const slots: Slot[] = Array.from({ length: 8 }, (_, index) => ({
    slotId: 'tailor-' + (index + 1), sourceAnalystNodeKey: analysts[index % analysts.length]!.key as string,
    writerNodeKey: 'writer-' + (index + 1), reviewerNodeKey: 'reviewer-' + (index + 1),
    ...(corrections.includes(index + 1) ? { correction: {
      writerNodeKey: 'correction-writer-' + (index + 1), reviewerNodeKey: 'correction-reviewer-' + (index + 1),
    } } : {}),
  }))
  const suffixNode = (key: string, templateId: string, dependency: string, depth: number): GraphNode => ({
    key, taskId: 'task-' + key, templateId, goal: 'Prepare a job-specific letter',
    successCriteria: ['Use only verified source findings'], dependsOn: [dependency], depth,
    verificationDisposition: 'specialized',
  })
  const writers = slots.map(slot => suffixNode(slot.writerNodeKey, 'cover_letter_writer', slot.sourceAnalystNodeKey, 3))
  const reviewers = slots.map(slot => suffixNode(slot.reviewerNodeKey, 'cover_letter_reviewer', slot.writerNodeKey, 4))
  const correctionWriters = slots.filter(slot => slot.correction).map(slot =>
    suffixNode(slot.correction!.writerNodeKey, 'cover_letter_writer', slot.reviewerNodeKey, 5))
  const correctionReviewers = slots.filter(slot => slot.correction).map(slot =>
    suffixNode(slot.correction!.reviewerNodeKey, 'cover_letter_reviewer', slot.correction!.writerNodeKey, 6))
  const graph = { schemaVersion: graphSchema, rootSuccessCriteria: ['Complete the selected job review'],
    nodes: [...sources, ...writers, ...reviewers, ...correctionWriters, ...correctionReviewers],
    objectiveTailor: { schemaVersion: markerSchema, sourceNodeCount: sources.length, slots } }
  const finalContent = { text: 'Verified final answer', objectiveTailorFinalOutcomes: {
    schemaVersion: sidecarSchema,
    slots: Array.from({ length: 8 }, (_, index) => ({ ordinal: index + 1, status: 'ready' })),
  } }
  return { graph, finalContent }
}

function ordinaryGraph(count = 1) {
  return { schemaVersion: graphSchema, nodes: Array.from({ length: count }, (_, index) => ({
    key: 'ordinary-' + index, taskId: 'task-ordinary-' + index, templateId: 'scout',
    goal: 'Find source roles', successCriteria: ['Return candidates'], dependsOn: [], depth: 1,
    verification: verification('scout'), verificationDisposition: 'typed',
  })) }
}

describe('readFinalTaskGraphSourceSnapshot', () => {
  it('keeps ordinary graphs unchanged and within the existing generic bound', () => {
    const ordinary = ordinaryGraph()
    const result = readFinalTaskGraphSourceSnapshot(ordinary, {})
    expect(result?.kind).toBe('ordinary')
    expect(result?.graph).toBe(ordinary)
    expect(result?.snapshot.nodes).toHaveLength(1)
    expect(readFinalTaskGraphSourceSnapshot(ordinaryGraph(0), {})).toBeNull()
    expect(readFinalTaskGraphSourceSnapshot(ordinaryGraph(12), {})).toBeNull()
  })

  it('projects the exact typed source prefix from a real 27-node marked Wave', () => {
    const { graph, finalContent } = wave()
    expect(graph.nodes).toHaveLength(27)
    expect(parseTaskGraphSnapshot(graph)).toBeNull()
    const result = readFinalTaskGraphSourceSnapshot(graph, finalContent)
    expect(result?.kind).toBe('objective-tailor')
    expect(result?.snapshot.nodes).toHaveLength(7)
    expect(result?.snapshot.nodes.map(node => node.templateId)).toEqual([
      'scout', 'scout', 'scout', 'analyst', 'analyst', 'analyst', 'analyst',
    ])
    expect(result?.snapshot.nodes.map(node => node.key)).toEqual(graph.nodes.slice(0, 7).map(node => node.key))
    expect(result?.snapshot.nodes.map(node => node.taskId)).toEqual(graph.nodes.slice(0, 7).map(node => node.taskId))
    const prefix = result?.graph as { schemaVersion: string; nodes: GraphNode[] }
    expect(prefix.nodes).toHaveLength(7)
    expect(prefix.nodes[3]?.verification).toEqual(verification('analyst'))
    expect(prefix).not.toHaveProperty('objectiveTailor')
    expect(prefix).not.toHaveProperty('rootSuccessCriteria')
  })

  it('fails closed on a present malformed marker, missing or invalid final sidecar, or slot mismatch', () => {
    const valid = wave()
    const malformed = { ...valid.graph, objectiveTailor: { ...valid.graph.objectiveTailor, sourceNodeCount: 6 } }
    expect(readFinalTaskGraphSourceSnapshot(malformed, valid.finalContent)).toBeNull()
    expect(readFinalTaskGraphSourceSnapshot(valid.graph, {})).toBeNull()
    expect(readFinalTaskGraphSourceSnapshot(valid.graph, { text: 'Answer', objectiveTailorFinalOutcomes: {
      ...valid.finalContent.objectiveTailorFinalOutcomes, privateProof: 'secret',
    } })).toBeNull()
    expect(readFinalTaskGraphSourceSnapshot(valid.graph, { text: 'Answer', objectiveTailorFinalOutcomes: {
      ...valid.finalContent.objectiveTailorFinalOutcomes,
      slots: valid.finalContent.objectiveTailorFinalOutcomes.slots.slice(0, 7),
    } })).toBeNull()
  })

  it('rejects duplicate or substituted identities without ordinary fallback', () => {
    const valid = wave()
    const duplicateTask = { ...valid.graph, nodes: valid.graph.nodes.map((node, index) =>
      index === 8 ? { ...node, taskId: valid.graph.nodes[0]!.taskId } : node) }
    const duplicateKey = { ...valid.graph, nodes: valid.graph.nodes.map((node, index) =>
      index === 8 ? { ...node, key: valid.graph.nodes[0]!.key } : node) }
    const foreignSuffix = { ...valid.graph, nodes: valid.graph.nodes.map((node, index) =>
      index === 7 ? { ...node, templateId: 'agent.plan' } : node) }
    for (const graph of [duplicateTask, duplicateKey, foreignSuffix]) {
      expect(readFinalTaskGraphSourceSnapshot(graph, valid.finalContent)).toBeNull()
      expect(parseTaskGraphSnapshot(graph)).toBeNull()
    }
  })

  it('treats an accessor marker as marked and invalid rather than trying the ordinary parser', () => {
    const valid = wave()
    const accessor = Object.defineProperty({ ...valid.graph }, 'objectiveTailor', {
      enumerable: true, get: () => valid.graph.objectiveTailor,
    })
    expect(readFinalTaskGraphSourceSnapshot(accessor, valid.finalContent)).toBeNull()
  })
})
