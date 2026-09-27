import { describe, expect, it } from 'vitest'

import { parseTaskGraphSnapshot, TASK_GRAPH_MAX_IDENTIFIER_LENGTH } from './task-graph-plan-snapshot'

const schemaVersion = 'agent-harness.v2.task-graph'

function graphNode(key: string, taskId: string, dependsOn: string[] = [], depth = dependsOn.length + 1) {
  return { key, templateId: 'scout', goal: `Snapshot ${key}`, successCriteria: [`Evidence for ${key}`], dependsOn, depth, taskId }
}

function maximalAsciiSnapshot() {
  const keys = Array.from({ length: 8 }, (_, index) => `${'k'.repeat(127)}${index}`)
  return {
    schemaVersion,
    nodes: keys.map((key, index) => ({
      key,
      templateId: 't'.repeat(128),
      goal: 'g'.repeat(1_200),
      successCriteria: Array.from({ length: 8 }, () => 'c'.repeat(320)),
      dependsOn: keys.slice(0, index),
      depth: index + 1,
      taskId: `${'x'.repeat(127)}${index}`,
    })),
  }
}

function snapshotAtUtf8ByteLimit() {
  const snapshot = maximalAsciiSnapshot()
  const first = snapshot.nodes[0]!
  first.goal = '😀'.repeat(600)
  first.successCriteria[0] = '😀'.repeat(160)
  first.successCriteria[1] = '😀'.repeat(160)
  first.successCriteria[2] = '😀'.repeat(160)
  first.successCriteria[3] = '😀'.repeat(13) + 'c'.repeat(294)
  return snapshot
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new TypeError('invalid fixture')
  return encoded
}

function canonicalJsonBytes(value: unknown) {
  return new TextEncoder().encode(canonicalJson(value)).byteLength
}

describe('TaskGraph snapshot parser', () => {
  it('parses the versioned snapshot as an object or JSON string and rejects malformed graphs', () => {
    const valid = { schemaVersion, nodes: [graphNode('a', 'task-a')] }
    expect(parseTaskGraphSnapshot(valid)?.nodes).toHaveLength(1)
    expect(parseTaskGraphSnapshot(JSON.stringify(valid))?.nodes).toHaveLength(1)
    expect(parseTaskGraphSnapshot({ ...valid, raw: 'PRIVATE_RAW_PAYLOAD' })).toBeNull()
    expect(parseTaskGraphSnapshot({ schemaVersion: 'future', nodes: valid.nodes })).toBeNull()
    expect(parseTaskGraphSnapshot({ schemaVersion, nodes: [graphNode('a', 'task-a', ['missing'])] })).toBeNull()
    expect(parseTaskGraphSnapshot({ schemaVersion, nodes: [graphNode('a', 'task-a', ['b']), graphNode('b', 'task-b', ['a'])] })).toBeNull()
    expect(parseTaskGraphSnapshot({ schemaVersion, nodes: [new Array(1)] })).toBeNull()
  })

  it('rejects hidden extra object keys and extra list properties', () => {
    const hiddenExtra = { schemaVersion, nodes: [graphNode('a', 'task-a')] }
    Object.defineProperty(hiddenExtra, 'unexpected', { value: true })
    const extraListProperty = Object.assign(['Evidence'], { unexpected: true })

    expect(parseTaskGraphSnapshot(hiddenExtra)).toBeNull()
    expect(parseTaskGraphSnapshot({ schemaVersion, nodes: [{ ...graphNode('a', 'task-a'), successCriteria: extraListProperty }] })).toBeNull()
  })

  it('rejects duplicate identities and oversized identifiers', () => {
    expect(parseTaskGraphSnapshot({ schemaVersion, nodes: [graphNode('a', 'task-a'), graphNode('b', 'task-a')] })).toBeNull()
    expect(parseTaskGraphSnapshot({ schemaVersion, nodes: [graphNode('a', 'task-a'), graphNode('a', 'task-b')] })).toBeNull()
    expect(parseTaskGraphSnapshot({ schemaVersion, nodes: [graphNode('a'.repeat(TASK_GRAPH_MAX_IDENTIFIER_LENGTH + 1), 'task-a')] })).toBeNull()
  })

  it('accepts eight nodes at depth eight and rejects larger graph limits', () => {
    const eightNodes = Array.from({ length: 8 }, (_, index) => graphNode(
      `node-${index}`,
      `task-${index}`,
      index === 0 ? [] : [`node-${index - 1}`],
      index + 1,
    ))

    expect(parseTaskGraphSnapshot({ schemaVersion, nodes: eightNodes })?.nodes).toHaveLength(8)
    expect(parseTaskGraphSnapshot({ schemaVersion, nodes: [...eightNodes, graphNode('node-8', 'task-8')] })).toBeNull()
    expect(parseTaskGraphSnapshot({ schemaVersion, nodes: [graphNode('deep', 'task-deep', [], 9)] })).toBeNull()
  })

  it('uses the canonical UTF-8 byte limit rather than the raw JSON string length', () => {
    const atLimit = snapshotAtUtf8ByteLimit()
    expect(canonicalJson(atLimit).length).toBeLessThan(40_000)
    expect(canonicalJsonBytes(atLimit)).toBe(40_000)
    expect(parseTaskGraphSnapshot(atLimit)?.nodes).toHaveLength(8)
    expect(parseTaskGraphSnapshot(JSON.stringify(atLimit).padEnd(45_000, ' '))?.nodes).toHaveLength(8)

    const overLimit = {
      ...atLimit,
      nodes: atLimit.nodes.map((node, index) => index === 1
        ? { ...node, goal: `é${node.goal.slice(1)}` }
        : node),
    }
    expect(canonicalJsonBytes(overLimit)).toBe(40_001)
    expect(parseTaskGraphSnapshot(overLimit)).toBeNull()
  })

  it('matches the Worker goal, criterion, dependency, and list limits', () => {
    const base = graphNode('node-1', 'task-1')
    expect(parseTaskGraphSnapshot({ schemaVersion, nodes: [{ ...base, goal: 'g'.repeat(1_200) }] })).not.toBeNull()
    expect(parseTaskGraphSnapshot({ schemaVersion, nodes: [{ ...base, goal: 'g'.repeat(1_201) }] })).toBeNull()
    expect(parseTaskGraphSnapshot({ schemaVersion, nodes: [{ ...base, successCriteria: Array(8).fill('c'.repeat(320)) }] })).not.toBeNull()
    expect(parseTaskGraphSnapshot({ schemaVersion, nodes: [{ ...base, successCriteria: Array(9).fill('criterion') }] })).toBeNull()
    expect(parseTaskGraphSnapshot({ schemaVersion, nodes: [{ ...base, successCriteria: ['c'.repeat(321)] }] })).toBeNull()
    expect(parseTaskGraphSnapshot({ schemaVersion, nodes: [{ ...base, dependsOn: Array(9).fill('dependency') }] })).toBeNull()
  })
})
