import { describe, expect, it } from 'vitest'

import { canonicalTaskGraphSourceKey } from './final-task-graph-source-detail'
import { readObjectiveTailorSourceGroups } from './objective-tailor-source-groups'
import { TASK_GRAPH_SOURCES_SCHEMA_VERSION, TASK_GRAPH_SOURCES_SCHEMA_VERSION_V2 } from './final-task-graph-source-manifest'

const finalItemId = 'final-item'
const graphRevision = 7
const scoutKey = canonicalTaskGraphSourceKey(finalItemId, graphRevision, 0)
const secondScoutKey = canonicalTaskGraphSourceKey(finalItemId, graphRevision, 1)
const analystKey = canonicalTaskGraphSourceKey(finalItemId, graphRevision, 2)
const manifest = {
  schemaVersion: TASK_GRAPH_SOURCES_SCHEMA_VERSION,
  graphRevision,
  sources: [
    { sourceKey: scoutKey, nodeIndex: 0, role: 'scout', taskStatus: 'completed', resultState: 'valid', roleResultStatus: 'completed' },
    { sourceKey: secondScoutKey, nodeIndex: 1, role: 'scout', taskStatus: 'completed', resultState: 'valid', roleResultStatus: 'partial' },
    { sourceKey: analystKey, nodeIndex: 2, role: 'analyst', taskStatus: 'completed', resultState: 'valid', roleResultStatus: 'completed' },
  ],
} as const
const outcome = {
  schemaVersion: 'agent-harness.v2.objective-tailor-final-outcomes.v2',
  graphRevision,
  slots: [{ ordinal: 1, status: 'ready' }],
  sourceCounts: {
    discoveredJobs: { knownCount: 2, coverage: 'partial' },
    analyzedJobs: { knownCount: 1, coverage: 'complete' },
  },
} as const
const schemaVersion = 'agent-harness.v2.objective-tailor-source-groups.v1'

function groups(overrides: Record<string, unknown> = {}) {
  return { schemaVersion, graphRevision, groups: { discoveredJobs: [scoutKey, secondScoutKey], analyzedJobs: [analystKey] }, ...overrides }
}

describe('readObjectiveTailorSourceGroups', () => {
  it('returns ordered current source groups when counts and roles agree', () => {
    expect(readObjectiveTailorSourceGroups(groups(), manifest, outcome)).toEqual(groups())
    const deduplicatedOutcome = { ...outcome, sourceCounts: {
      discoveredJobs: { knownCount: 1, coverage: 'partial' as const },
      analyzedJobs: { knownCount: 1, coverage: 'complete' as const },
    } }
    expect(readObjectiveTailorSourceGroups(groups(), manifest, deduplicatedOutcome)).toEqual(groups())
  })

  it.each([
    ['wrong role', groups({ groups: { discoveredJobs: [scoutKey, analystKey], analyzedJobs: [analystKey] } })],
    ['stale revision', groups({ graphRevision: graphRevision + 1 })],
    ['foreign key', groups({ groups: { discoveredJobs: [scoutKey, 'src_foreign'], analyzedJobs: [analystKey] } })],
    ['duplicate key', groups({ groups: { discoveredJobs: [scoutKey, scoutKey], analyzedJobs: [analystKey] } })],
    ['noncanonical node order', groups({ groups: { discoveredJobs: [secondScoutKey, scoutKey], analyzedJobs: [analystKey] } })],
    ['positive count with no source', groups({ groups: { discoveredJobs: [], analyzedJobs: [analystKey] } })],
  ])('rejects %s', (_name, value) => {
    expect(readObjectiveTailorSourceGroups(value, manifest, outcome)).toBeUndefined()
  })

  it('rejects a failed or historical source even when its key is present in the manifest', () => {
    const failed = { ...manifest.sources[0], taskStatus: 'failed' as const }
    expect(readObjectiveTailorSourceGroups(groups(), { ...manifest, sources: [failed, ...manifest.sources.slice(1)] }, outcome)).toBeUndefined()
    const invalid = { ...manifest.sources[1], resultState: 'missing' as const }
    expect(readObjectiveTailorSourceGroups(groups(), { ...manifest, sources: [manifest.sources[0], invalid, manifest.sources[2]] }, outcome)).toBeUndefined()

    const historical = {
      schemaVersion: TASK_GRAPH_SOURCES_SCHEMA_VERSION_V2,
      graphRevision,
      sources: manifest.sources.slice(1),
      historicalNodeIndices: [0],
    }
    expect(readObjectiveTailorSourceGroups(groups({ groups: { discoveredJobs: [scoutKey, secondScoutKey], analyzedJobs: [analystKey] } }), historical, outcome)).toBeUndefined()
  })

  it('keeps zero and unavailable groups empty and does not create links for legacy outcomes', () => {
    const zeroOutcome = { ...outcome, sourceCounts: {
      discoveredJobs: { knownCount: 0, coverage: 'complete' as const },
      analyzedJobs: { knownCount: null, coverage: 'unavailable' as const },
    } }
    const empty = groups({ groups: { discoveredJobs: [], analyzedJobs: [] } })
    expect(readObjectiveTailorSourceGroups(empty, manifest, zeroOutcome)).toEqual(empty)
    expect(readObjectiveTailorSourceGroups(empty, manifest, { schemaVersion: 'agent-harness.v2.objective-tailor-final-outcomes.v1', slots: outcome.slots })).toBeUndefined()
    expect(readObjectiveTailorSourceGroups({ ...empty, graphRevision: graphRevision + 1 }, manifest, zeroOutcome)).toBeUndefined()
    expect(readObjectiveTailorSourceGroups(groups({ groups: { discoveredJobs: [scoutKey], analyzedJobs: [] } }), manifest, zeroOutcome)).toBeUndefined()
  })

  it('rejects a positive count with no current contributing source', () => {
    const unavailable = { ...outcome, sourceCounts: {
      discoveredJobs: { knownCount: 1, coverage: 'partial' as const },
      analyzedJobs: { knownCount: 1, coverage: 'complete' as const },
    } }
    expect(readObjectiveTailorSourceGroups(groups({ groups: { discoveredJobs: [], analyzedJobs: [analystKey] } }), manifest, unavailable)).toBeUndefined()
  })
})
