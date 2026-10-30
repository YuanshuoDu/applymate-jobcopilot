import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { isCanonicalTaskGraphSourceManifestWeb, parseFinalTaskGraphSourceManifest, TASK_GRAPH_SOURCES_SCHEMA_VERSION } from './final-task-graph-source-manifest'

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
    expect(parseFinalTaskGraphSourceManifest(valid)).toEqual(valid)
    const serialized = JSON.stringify(parseFinalTaskGraphSourceManifest(valid))
    expect(serialized).not.toMatch(/taskId|graphItemId|sessionId|userId|jobId|artifactId|goal|summary|resultText/i)
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
    expect(await isCanonicalTaskGraphSourceManifestWeb('other-item', manifest)).toBe(false)

    const crypto = globalThis.crypto
    vi.stubGlobal('crypto', undefined)
    try { expect(await isCanonicalTaskGraphSourceManifestWeb(finalItemId, manifest)).toBe(false) }
    finally { vi.stubGlobal('crypto', crypto) }
  })
})
