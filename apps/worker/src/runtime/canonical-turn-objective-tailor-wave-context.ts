import type { StepContextSnapshot } from "./context/step-context-builder.js"
import { OBJECTIVE_TAILOR_WAVE_CATALOG_SCHEMA, type ObjectiveTailorWaveCandidateCatalog } from "./subagents/objective-tailor-candidate-v2.js"
import { OBJECTIVE_TAILOR_WAVE_OUTCOME_SCHEMA, type ObjectiveTailorWaveOutcomeObservation } from "./objective-tailor-wave-outcome-projection.js"
import type { TaskGraphReadScope } from "./subagents/task-graph-command-port.js"
import type { TurnLease } from "./turns/lease.js"
import type { ObjectiveTailorCandidateCatalog } from "./subagents/objective-tailor-candidate.js"
import { appendObjectiveTailorCandidateCatalog } from "./canonical-turn-task-graph-context.js"
import { TurnEngineError } from "./turns/turn-engine-output.js"
import { TurnLeaseError } from "./turns/lease.js"

export const OBJECTIVE_TAILOR_WAVE_CATALOG_OBSERVATION_ID = "objective-tailor-wave-candidate-catalog"
export const OBJECTIVE_TAILOR_WAVE_OUTCOME_OBSERVATION_ID = "objective-tailor-wave-outcomes"
const MAX_CANDIDATES = 8
const OUTCOME_STATUSES = new Set(["pending", "ready", "needs_revision", "rejected", "stale", "failed"])
const EFFECTIVE_PAIRS = new Set(["initial", "correction"])

type WaveContextReaders = Readonly<{
  catalog?: (scope: TaskGraphReadScope) => Promise<ObjectiveTailorCandidateCatalog | undefined>
  waveCatalog?: (scope: TaskGraphReadScope) => Promise<ObjectiveTailorWaveCandidateCatalog | undefined>
  progress?: () => Promise<ObjectiveTailorWaveOutcomeObservation | undefined>
}>

/** Loads only enabled Objective context readers and drops stale or unbound outcome projections. */
export async function appendObjectiveTailorWaveContextFromReaders(input: Readonly<{
  snapshot: StepContextSnapshot; expectedRevision: number | undefined; readers: WaveContextReaders
  userId: string; lease: TurnLease; rootTaskId: string; rootAttemptCount: number
}>): Promise<StepContextSnapshot> {
  let snapshot = input.snapshot
  const readScope: TaskGraphReadScope = { userId: input.userId, sessionId: input.lease.sessionId, turnId: input.lease.turnId,
    rootTaskId: input.rootTaskId, parentTaskId: input.rootTaskId, turnLeaseOwner: input.lease.ownerId,
    turnLeaseVersion: input.lease.leaseVersion, parentLeaseOwner: input.lease.ownerId, parentAttemptCount: input.rootAttemptCount }
  try {
    if (input.readers.catalog) snapshot = appendObjectiveTailorCandidateCatalog(snapshot,
      await input.readers.catalog(readScope), input.expectedRevision)
    else if (input.readers.waveCatalog) snapshot = appendObjectiveTailorWaveCandidateCatalog(snapshot,
      await input.readers.waveCatalog(readScope), input.expectedRevision)
  } catch (error: unknown) {
    if (error instanceof TurnLeaseError || error instanceof TurnEngineError) throw error
  }
  if (input.readers.progress && input.expectedRevision !== undefined) {
    const currentWave = objectiveTailorWaveSlotsFromCurrentGraph(
      snapshot.toolObservations.find(observation => observation.id === "task-graph-current")?.content)
    try {
      snapshot = appendObjectiveTailorWaveOutcomeObservation(snapshot, await input.readers.progress(), input.expectedRevision,
        currentWave?.graphRevision === input.expectedRevision ? currentWave.slots : undefined)
    } catch (error: unknown) {
      if (error instanceof TurnLeaseError || error instanceof TurnEngineError) throw error
    }
  }
  return snapshot
}

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

/** Replaces caller or stale outcome data only with a closed projection for the exact current graph. */
export function appendObjectiveTailorWaveOutcomeObservation(
  snapshot: StepContextSnapshot, value: unknown, expectedRevision: number | undefined,
  expectedSlots?: readonly Readonly<{ slotId: string; effectivePair: "initial" | "correction" }>[],
): StepContextSnapshot {
  const observation = expectedSlots ? parseObjectiveTailorWaveOutcomeObservation(value, expectedRevision, expectedSlots) : undefined
  return { ...snapshot, toolObservations: [
    ...snapshot.toolObservations.filter(item => item.id !== OBJECTIVE_TAILOR_WAVE_OUTCOME_OBSERVATION_ID),
    ...(observation ? [{ id: OBJECTIVE_TAILOR_WAVE_OUTCOME_OBSERVATION_ID, content: { kind: "objective_tailor_wave_outcomes", ...observation } }] : []),
  ] }
}

/** Reads only slot identities and effective-pair kinds from the current bounded TaskGraph view. */
export function objectiveTailorWaveSlotsFromCurrentGraph(value: unknown): Readonly<{
  graphRevision: number; slots: readonly Readonly<{ slotId: string; effectivePair: "initial" | "correction" }>[]
}> | undefined {
  try {
    const graph = ownRecord(value), revision = graph?.revision
    const wave = graph && exactRecord(graph.objectiveTailorWave, ["graphRevision", "ordinaryPlanAppend", "schemaVersion", "slots", "sourceNodeCount"])
    if (!graph || graph.kind !== "task_graph_current" || !Number.isSafeInteger(revision) || Number(revision) < 1 || !wave
      || wave.schemaVersion !== "agent-harness.v2.objective-tailor-wave-view.v1" || wave.graphRevision !== revision
      || wave.ordinaryPlanAppend !== "closed" || !Number.isSafeInteger(wave.sourceNodeCount)
      || Number(wave.sourceNodeCount) < 2 || Number(wave.sourceNodeCount) > 40) return undefined
    if (!Array.isArray(wave.slots) || Object.getPrototypeOf(wave.slots) !== Array.prototype || wave.slots.length < 1
      || wave.slots.length > MAX_CANDIDATES || Reflect.ownKeys(wave.slots).length !== wave.slots.length + 1) return undefined
    const slots: { slotId: string; effectivePair: "initial" | "correction" }[] = []
    for (let index = 0; index < wave.slots.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(wave.slots, String(index))
      const candidate = descriptor?.enumerable && "value" in descriptor ? ownRecord(descriptor.value) : undefined
      const row = candidate && exactRecord(descriptor!.value, candidate.effectivePair === "correction"
        ? ["correction", "effectivePair", "initial", "slotId", "sourceAnalystNodeKey"]
        : ["effectivePair", "initial", "slotId", "sourceAnalystNodeKey"])
      if (!row || row.slotId !== `tailor-${index + 1}` || typeof row.sourceAnalystNodeKey !== "string"
        || !row.sourceAnalystNodeKey.trim() || row.effectivePair !== "initial" && row.effectivePair !== "correction"
        || !validPair(row.initial) || row.effectivePair === "correction" && !validPair(row.correction)
        || row.effectivePair === "initial" && Object.hasOwn(row, "correction")) return undefined
      slots.push({ slotId: row.slotId as string, effectivePair: row.effectivePair as "initial" | "correction" })
    }
    return { graphRevision: Number(revision), slots }
  } catch { return undefined }
}

export function parseObjectiveTailorWaveOutcomeObservation(
  value: unknown, expectedRevision: number | undefined,
  expectedSlots?: readonly Readonly<{ slotId: string; effectivePair: "initial" | "correction" }>[],
): ObjectiveTailorWaveOutcomeObservation | undefined {
  try {
    const row = exactRecord(value, ["graphRevision", "schemaVersion", "slots"])
    if (!row || row.schemaVersion !== OBJECTIVE_TAILOR_WAVE_OUTCOME_SCHEMA || !Number.isSafeInteger(row.graphRevision)
      || !Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1 || row.graphRevision !== expectedRevision
      || !Array.isArray(row.slots) || Object.getPrototypeOf(row.slots) !== Array.prototype
      || row.slots.length < 1 || row.slots.length > MAX_CANDIDATES || Reflect.ownKeys(row.slots).length !== row.slots.length + 1
      || expectedSlots && expectedSlots.length !== row.slots.length) return undefined
    const slots: ObjectiveTailorWaveOutcomeObservation["slots"][number][] = []
    for (let index = 0; index < row.slots.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(row.slots, String(index))
      const slot = descriptor?.enumerable && "value" in descriptor
        ? exactRecord(descriptor.value, ["effectivePair", "slotId", "status"]) : undefined
      const expected = expectedSlots?.[index]
      if (!slot || slot.slotId !== `tailor-${index + 1}` || !EFFECTIVE_PAIRS.has(String(slot.effectivePair))
        || !OUTCOME_STATUSES.has(String(slot.status)) || expected && (expected.slotId !== slot.slotId || expected.effectivePair !== slot.effectivePair)) return undefined
      slots.push({ slotId: slot.slotId as string, effectivePair: slot.effectivePair as "initial" | "correction",
        status: slot.status as ObjectiveTailorWaveOutcomeObservation["slots"][number]["status"] })
    }
    return { schemaVersion: OBJECTIVE_TAILOR_WAVE_OUTCOME_SCHEMA, graphRevision: Number(row.graphRevision), slots }
  } catch { return undefined }
}

function ownRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return undefined
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return undefined
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined
    }
    return value as Record<string, unknown>
  } catch { return undefined }
}
function validPair(value: unknown): boolean {
  const pair = exactRecord(value, ["reviewer", "writer"])
  return !!pair && validChild(pair.reviewer) && validChild(pair.writer)
}
function validChild(value: unknown): boolean {
  const child = exactRecord(value, ["readiness", "status", "taskId"])
  return !!child && typeof child.taskId === "string" && !!child.taskId.trim()
    && ["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"].includes(String(child.status))
    && ["ready", "waiting_for_dependencies", "blocked_dependency", "active", "terminal"].includes(String(child.readiness))
}
