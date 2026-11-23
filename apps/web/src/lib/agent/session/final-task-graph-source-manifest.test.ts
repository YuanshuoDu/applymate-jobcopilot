import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { isCanonicalTaskGraphSourceManifestWeb, parseFinalTaskGraphSourceManifest, TASK_GRAPH_SOURCES_SCHEMA_VERSION,
  TASK_GRAPH_SOURCES_SCHEMA_VERSION_V2, TASK_GRAPH_SOURCES_SCHEMA_VERSION_V3 } from './final-task-graph-source-manifest'

const key = (letter: string) => `src_${letter.repeat(43)}`
const valid = {
  schemaVersion: TASK_GRAPH_SOURCES_SCHEMA_VERSION,
  graphRevision: 4,
  sources: [
    { sourceKey: key('A'), nodeIndex: 0, role: 'scout', taskStatus: 'completed', resultState: 'valid', roleResultStatus: 'completed' },
    { sourceKey: key('B'), nodeIndex: 2, role: 'analyst', taskStatus: 'failed', resultState: 'missing' },
  ],
}

describe('parseFinalTaskGraphSourceManifest', () => {
  it('projects only fixed, bounded positional fields and preserves valid outcome enums', () => {
    expect(valid.schemaVersion).toBe('agent-harness.v2.task-graph-sources.v1')
    expect(parseFinalTaskGraphSourceManifest(valid)).toEqual(valid)
    const serialized = JSON.stringify(parseFinalTaskGraphSourceManifest(valid))
    expect(serialized).not.toMatch(/taskId|graphItemId|sessionId|userId|jobId|artifactId|goal|summary|resultText/i)
  })

  it('parses strict v2 historical indices without changing the v1 contract', () => {
    const v2 = { ...valid, schemaVersion: TASK_GRAPH_SOURCES_SCHEMA_VERSION_V2, historicalNodeIndices: [1] }
    expect(parseFinalTaskGraphSourceManifest(v2)).toEqual(v2)
    const tooManySources = Array.from({ length: 9 }, (_, nodeIndex) => ({ ...valid.sources[0]!,
      sourceKey: key(String.fromCharCode(65 + nodeIndex)), nodeIndex }))
    const overlappingSource = { ...valid.sources[1]!, nodeIndex: 1 }
    const cases = [
      { ...v2, extra: true },
      { ...v2, schemaVersion: 'agent-harness.v2.task-graph-sources.v3' },
      { ...v2, sources: tooManySources },
      { ...v2, historicalNodeIndices: [] },
      { ...v2, historicalNodeIndices: [1, 1] },
      { ...v2, historicalNodeIndices: [2, 1] },
      { ...v2, historicalNodeIndices: [8] },
      { ...v2, sources: [valid.sources[0], overlappingSource] },
      { ...v2, historicalNodeIndices: [2] },
      { ...v2, historicalNodeIndices: [1, 3, 4, 5, 6, 7, 0, 2] },
      { ...valid, historicalNodeIndices: [1] },
    ]
    for (const value of cases) expect(parseFinalTaskGraphSourceManifest(value)).toBeNull()
  })

  it('parses v3 opaque artifact proofs with empty history and preserves the exact commitment', () => {
    const v3 = { ...valid, schemaVersion: TASK_GRAPH_SOURCES_SCHEMA_VERSION_V3, historicalNodeIndices: [],
      sources: [{ ...valid.sources[0]!, role: 'writer', artifactVersionProof: `avp_${'a'.repeat(64)}` }, valid.sources[1]!] }
    expect(parseFinalTaskGraphSourceManifest(v3)).toEqual(v3)
    expect(JSON.stringify(parseFinalTaskGraphSourceManifest(v3))).not.toMatch(/artifactId|contentHash|sourceDigest|jobId|taskId/i)
  })

  it('accepts V3 only when at least one eligible terminal artifact proof is present', () => {
    const v3 = { ...valid, schemaVersion: TASK_GRAPH_SOURCES_SCHEMA_VERSION_V3, historicalNodeIndices: [1],
      sources: [{ ...valid.sources[0]!, role: 'reviewer', artifactVersionProof: `avp_${'b'.repeat(64)}` }] }
    const invalidSources = [
      { ...v3.sources[0]!, role: 'scout' },
      { ...v3.sources[0]!, taskStatus: 'failed' },
      { ...v3.sources[0]!, resultState: 'missing', roleResultStatus: undefined },
      { ...v3.sources[0]!, roleResultStatus: 'partial' },
      { ...v3.sources[0]!, artifactVersionProof: 'sha256:bad' },
      { ...v3.sources[0]!, artifactVersionProof: undefined },
      { ...v3.sources[0]!, artifactRef: { artifactId: 'private' } },
    ]
    for (const source of invalidSources) expect(parseFinalTaskGraphSourceManifest({ ...v3, sources: [source] })).toBeNull()
    const proofless = Object.fromEntries(Object.entries(v3.sources[0]!).filter(([key]) => key !== 'artifactVersionProof'))
    expect(parseFinalTaskGraphSourceManifest({ ...v3, sources: [proofless] })).toBeNull()
    expect(parseFinalTaskGraphSourceManifest({ ...v3, historicalNodeIndices: [0] })).toBeNull()
  })

  it('rejects accessor-backed fields before invoking them', () => {
    let invoked = false
    const accessorManifest = { ...valid }
    Object.defineProperty(accessorManifest, 'schemaVersion', { enumerable: true, get: () => { invoked = true; return valid.schemaVersion } })
    expect(parseFinalTaskGraphSourceManifest(accessorManifest)).toBeNull()
    expect(invoked).toBe(false)

    const accessorRevision = { ...valid }
    Object.defineProperty(accessorRevision, 'graphRevision', { enumerable: true, get: () => { invoked = true; return valid.graphRevision } })
    expect(parseFinalTaskGraphSourceManifest(accessorRevision)).toBeNull()
    expect(invoked).toBe(false)

    const accessorSource = { ...valid.sources[0]! }
    Object.defineProperty(accessorSource, 'nodeIndex', { enumerable: true, get: () => { invoked = true; return 0 } })
    expect(parseFinalTaskGraphSourceManifest({ ...valid, sources: [accessorSource] })).toBeNull()
    expect(invoked).toBe(false)

    const accessorSources = [...valid.sources]
    Object.defineProperty(accessorSources, '0', { enumerable: true, configurable: true,
      get: () => { invoked = true; return valid.sources[0] } })
    expect(parseFinalTaskGraphSourceManifest({ ...valid, sources: accessorSources })).toBeNull()
    expect(invoked).toBe(false)

    const historicalNodeIndices = new Array(1)
    Object.defineProperty(historicalNodeIndices, '0', { enumerable: true, get: () => { invoked = true; return 1 } })
    expect(parseFinalTaskGraphSourceManifest({ ...valid, schemaVersion: TASK_GRAPH_SOURCES_SCHEMA_VERSION_V2,
      historicalNodeIndices })).toBeNull()
    expect(invoked).toBe(false)
  })

  it('rejects malformed, extra, oversized, duplicate, or unordered manifest fields', () => {
    const cases = [
      { ...valid, private: 'raw model result' },
      { ...valid, graphRevision: 0 },
      { ...valid, graphRevision: 1.5 },
      { ...valid, sources: [] },
      { ...valid, sources: Array.from({ length: 9 }, (_, nodeIndex) => ({ ...valid.sources[0], sourceKey: key(String.fromCharCode(65 + nodeIndex)), nodeIndex })) },
      { ...valid, sources: [valid.sources[0], { ...valid.sources[1], sourceKey: valid.sources[0]!.sourceKey }] },
      { ...valid, sources: [valid.sources[0], { ...valid.sources[1], nodeIndex: 0 }] },
      { ...valid, sources: [valid.sources[1], valid.sources[0]] },
      { ...valid, sources: [{ ...valid.sources[0], rawTaskId: 'task_private' }] },
      { ...valid, sources: [{ ...valid.sources[0], role: 'model-invented-role' }] },
      { ...valid, sources: [{ ...valid.sources[0], resultState: 'valid', roleResultStatus: undefined }] },
    ]
    for (const value of cases) expect(parseFinalTaskGraphSourceManifest(value)).toBeNull()
  })

  it('enforces result-state, task-state, and role-result coherence', () => {
    const cases = [
      { ...valid.sources[0], role: 'unsupported' },
      { ...valid.sources[0], roleResultStatus: 'partial', role: 'writer' },
      { ...valid.sources[0], taskStatus: 'running' },
      { ...valid.sources[0], resultState: 'not_terminal', roleResultStatus: undefined, taskStatus: 'completed' },
      { ...valid.sources[0], resultState: 'unsupported_role', role: 'scout' },
      { ...valid.sources[0], role: 'unsupported', resultState: 'missing' },
      { ...valid.sources[0], resultState: 'missing', roleResultStatus: 'completed' },
    ]
    for (const source of cases) expect(parseFinalTaskGraphSourceManifest({ ...valid, sources: [source] })).toBeNull()
  })

  it('checks browser SHA-256 keys against Worker base64url output and fails closed without Web Crypto', async () => {
    const finalItemId = 'item-final-1'
    const workerKey = (nodeIndex: number) => `src_${createHash('sha256')
      .update(`taskGraphSource:v1\0${finalItemId}\0${valid.graphRevision}\0${nodeIndex}`).digest('base64url')}`
    const manifest = parseFinalTaskGraphSourceManifest({ ...valid,
      sources: valid.sources.map(source => ({ ...source, sourceKey: workerKey(source.nodeIndex) })) })!
    expect(await isCanonicalTaskGraphSourceManifestWeb(finalItemId, manifest)).toBe(true)
    const v2Manifest = parseFinalTaskGraphSourceManifest({ ...valid,
      schemaVersion: TASK_GRAPH_SOURCES_SCHEMA_VERSION_V2, historicalNodeIndices: [1],
      sources: valid.sources.map(source => ({ ...source, sourceKey: workerKey(source.nodeIndex) })) })!
    expect(await isCanonicalTaskGraphSourceManifestWeb(finalItemId, v2Manifest)).toBe(true)
    const v3Manifest = parseFinalTaskGraphSourceManifest({ ...valid,
      schemaVersion: TASK_GRAPH_SOURCES_SCHEMA_VERSION_V3, historicalNodeIndices: [],
      sources: [{ ...valid.sources[0]!, role: 'writer', artifactVersionProof: `avp_${'c'.repeat(64)}`, sourceKey: workerKey(0) }] })!
    expect(await isCanonicalTaskGraphSourceManifestWeb(finalItemId, v3Manifest)).toBe(true)
    expect(await isCanonicalTaskGraphSourceManifestWeb('other-item', manifest)).toBe(false)

    const crypto = globalThis.crypto
    vi.stubGlobal('crypto', undefined)
    try { expect(await isCanonicalTaskGraphSourceManifestWeb(finalItemId, manifest)).toBe(false) }
    finally { vi.stubGlobal('crypto', crypto) }
  })
})
