import {
  parseObjectiveTailorSourceGroups,
  type ObjectiveTailorFinalOutcomeSidecar,
  type ObjectiveTailorSourceGroups,
} from '@jobcopilot/agent-protocol'

import type { FinalTaskGraphSourceManifest, FinalTaskGraphSource } from './final-task-graph-source-manifest'

type SourceCount = Readonly<{ knownCount: number | null; coverage: 'complete' | 'partial' | 'unavailable' | 'not_requested' }>

/**
 * Binds the opaque source-group sibling to the already validated final manifest
 * and the exact Objective outcome counts. A malformed sibling is optional
 * evidence: callers retain the ordinary counts and navigation when it fails.
 */
export function readObjectiveTailorSourceGroups(
  value: unknown,
  manifest: FinalTaskGraphSourceManifest | null | undefined,
  outcome: ObjectiveTailorFinalOutcomeSidecar | null | undefined,
): ObjectiveTailorSourceGroups | undefined {
  const groups = parseObjectiveTailorSourceGroups(value)
  if (!groups || !manifest || !outcome || !hasSourceCounts(outcome)
    || groups.graphRevision !== manifest.graphRevision || groups.graphRevision !== outcome.graphRevision) return undefined

  const byKey = new Map(manifest.sources.map(source => [source.sourceKey, source]))
  const discoveredJobs = readGroup(groups.groups.discoveredJobs, manifest.sources, byKey, 'scout', outcome.sourceCounts.discoveredJobs)
  const analyzedJobs = readGroup(groups.groups.analyzedJobs, manifest.sources, byKey, 'analyst', outcome.sourceCounts.analyzedJobs)
  if (!discoveredJobs || !analyzedJobs) return undefined

  return {
    schemaVersion: groups.schemaVersion,
    graphRevision: groups.graphRevision,
    groups: { discoveredJobs, analyzedJobs },
  }
}

function readGroup(
  keys: readonly string[],
  manifestSources: readonly FinalTaskGraphSource[],
  byKey: ReadonlyMap<string, FinalTaskGraphSource>,
  role: 'scout' | 'analyst',
  count: SourceCount,
): readonly string[] | undefined {
  if (keys.length > manifestSources.length) return undefined
  if (count.coverage === 'unavailable' || count.coverage === 'not_requested') {
    return count.knownCount === null && keys.length === 0 ? [] : undefined
  }
  if (count.knownCount === null) return undefined
  if (count.knownCount === 0) return keys.length === 0 ? [] : undefined
  if (keys.length === 0) return undefined

  const seen = new Set<string>()
  let previousNodeIndex = -1
  for (const key of keys) {
    if (seen.has(key)) return undefined
    seen.add(key)
    const source = byKey.get(key)
    if (!source || source.role !== role || source.resultState !== 'valid' || source.taskStatus !== 'completed'
      || source.nodeIndex <= previousNodeIndex) return undefined
    previousNodeIndex = source.nodeIndex
  }
  return [...keys]
}

function hasSourceCounts(outcome: ObjectiveTailorFinalOutcomeSidecar): outcome is ObjectiveTailorFinalOutcomeSidecar & Readonly<{
  graphRevision: number
  sourceCounts: Readonly<{ discoveredJobs: SourceCount; analyzedJobs: SourceCount }>
}> {
  return 'graphRevision' in outcome && 'sourceCounts' in outcome
}
