import type { StepContextSnapshot } from "./context/step-context-builder.js"
import { OBJECTIVE_TAILOR_WAVE_CATALOG_SCHEMA, type ObjectiveTailorWaveCandidateCatalog } from "./subagents/objective-tailor-candidate-v2.js"

export const OBJECTIVE_TAILOR_WAVE_CATALOG_OBSERVATION_ID = "objective-tailor-wave-candidate-catalog"
const MAX_CANDIDATES = 8

/** Replaces the prior wave catalog with only a bounded public projection for the exact graph revision. */
export function appendObjectiveTailorWaveCandidateCatalog(
  snapshot: StepContextSnapshot, value: unknown, expectedRevision: number | undefined,
): StepContextSnapshot {
  const catalog = parseObjectiveTailorWaveCandidateCatalog(value, expectedRevision)
  return { ...snapshot, toolObservations: [
    ...snapshot.toolObservations.filter(observation => observation.id !== OBJECTIVE_TAILOR_WAVE_CATALOG_OBSERVATION_ID),
    ...(catalog ? [{ id: OBJECTIVE_TAILOR_WAVE_CATALOG_OBSERVATION_ID,
      content: { kind: "objective_tailor_wave_candidate_catalog", catalog } }] : []),
  ] }
}

function parseObjectiveTailorWaveCandidateCatalog(value: unknown, expectedRevision: number | undefined): ObjectiveTailorWaveCandidateCatalog | undefined {
  try {
    const row = exactRecord(value, ["candidates", "graphRevision", "schemaVersion"])
    if (!row || row.schemaVersion !== OBJECTIVE_TAILOR_WAVE_CATALOG_SCHEMA || !Number.isSafeInteger(row.graphRevision)
      || row.graphRevision !== expectedRevision || !Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1
      || !Array.isArray(row.candidates) || Object.getPrototypeOf(row.candidates) !== Array.prototype
      || row.candidates.length > MAX_CANDIDATES || Reflect.ownKeys(row.candidates).length !== row.candidates.length + 1) return undefined
    const candidates: ObjectiveTailorWaveCandidateCatalog["candidates"][number][] = [], refs = new Set<string>()
    for (let index = 0; index < row.candidates.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(row.candidates, String(index))
      const candidate = descriptor?.enumerable && "value" in descriptor
        ? exactRecord(descriptor.value, ["candidateRef", "company", "score", "title"]) : undefined
      if (!candidate || typeof candidate.candidateRef !== "string" || !/^otc2_[a-f0-9]{64}$/.test(candidate.candidateRef)
        || refs.has(candidate.candidateRef) || typeof candidate.title !== "string" || !candidate.title.trim()
        || candidate.title.trim() !== candidate.title || candidate.title.length > 160 || typeof candidate.company !== "string"
        || !candidate.company.trim() || candidate.company.trim() !== candidate.company || candidate.company.length > 160
        || typeof candidate.score !== "number" || !Number.isFinite(candidate.score) || candidate.score < 0 || candidate.score > 10) return undefined
      refs.add(candidate.candidateRef)
      candidates.push({ candidateRef: candidate.candidateRef, title: candidate.title, company: candidate.company, score: candidate.score })
    }
    return { schemaVersion: OBJECTIVE_TAILOR_WAVE_CATALOG_SCHEMA, graphRevision: Number(row.graphRevision), candidates }
  } catch { return undefined }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return undefined
    const actual = Reflect.ownKeys(value)
    if (actual.length !== keys.length || actual.some(key => typeof key !== "string" || !keys.includes(key))) return undefined
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined
    }
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of keys) copy[key] = Object.getOwnPropertyDescriptor(value, key)!.value
    return copy
  } catch { return undefined }
}
