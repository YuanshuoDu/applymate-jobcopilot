import { hashContent } from "./canonical-json.js"

export const OBJECTIVE_APPLICATION_RESUME_WITNESS_SCHEMA = "objective-application-resume-witness.v1" as const

const MATERIAL_KEYS = [
  "basicsDetached",
  "content",
  "kind",
  "name",
  "parentResumeId",
  "targetJobId",
  "templateId",
  "templateOptions",
] as const

export type ObjectiveApplicationResumeMaterial = Readonly<{
  name: string
  content: unknown
  templateId: string | null
  templateOptions: unknown | null
  kind: string
  targetJobId: string | null
  parentResumeId: string | null
  basicsDetached: boolean
}>

export type ObjectiveApplicationResumeWitness = Readonly<{
  schema: typeof OBJECTIVE_APPLICATION_RESUME_WITNESS_SCHEMA
  userId: string
  jobId: string
  resumeId: string
  finalResumeAssignmentRevision: number
  materialRevision: number
  resumeMaterialHash: string
}>

type WitnessSeed = Readonly<{
  userId: string
  jobId: string
  resumeId: string
  finalResumeAssignmentRevision: number
  materialRevision: number
  material: ObjectiveApplicationResumeMaterial
}>

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null
  try {
    if (Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    const ownKeys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || ownKeys.length !== keys.length) return null
    const expected = new Set(keys)
    for (const key of ownKeys) {
      if (typeof key !== "string" || !expected.delete(key)) return null
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null
    }
    return value as Record<string, unknown>
  } catch {
    return null
  }
}

function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim() && value.length <= 256
}

function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object") return false
  try {
    if (ancestors.has(value)) return false
    ancestors.add(value)
    const keys = Reflect.ownKeys(value)
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || keys.length !== value.length + 1) return false
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || !isJsonValue(descriptor.value, ancestors)) return false
      }
      return true
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    for (const key of keys) {
      if (typeof key !== "string") return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || !isJsonValue(descriptor.value, ancestors)) return false
    }
    return true
  } catch {
    return false
  } finally {
    if (typeof value === "object" && value !== null) ancestors.delete(value)
  }
}

function materialHash(value: unknown): string | null {
  const material = exactRecord(value, MATERIAL_KEYS)
  if (!material || typeof material.name !== "string" || typeof material.kind !== "string"
    || typeof material.basicsDetached !== "boolean"
    || !(material.templateId === null || typeof material.templateId === "string")
    || !(material.targetJobId === null || typeof material.targetJobId === "string")
    || !(material.parentResumeId === null || typeof material.parentResumeId === "string")
    || !isJsonValue(material.content) || !(material.templateOptions === null || isJsonValue(material.templateOptions))) return null
  try {
    return hashContent([
      "objective-application-resume-material.v1",
      material.name,
      material.content,
      material.templateId,
      material.templateOptions,
      material.kind,
      material.targetJobId,
      material.parentResumeId,
      material.basicsDetached,
    ])
  } catch {
    return null
  }
}

export function parseObjectiveApplicationResumeWitness(value: unknown): ObjectiveApplicationResumeWitness | null {
  const record = exactRecord(value, [
    "schema", "userId", "jobId", "resumeId", "finalResumeAssignmentRevision", "materialRevision", "resumeMaterialHash",
  ])
  if (!record || record.schema !== OBJECTIVE_APPLICATION_RESUME_WITNESS_SCHEMA
    || !boundedId(record.userId) || !boundedId(record.jobId) || !boundedId(record.resumeId)
    || !revision(record.finalResumeAssignmentRevision) || !revision(record.materialRevision)
    || typeof record.resumeMaterialHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(record.resumeMaterialHash)) return null
  return {
    schema: OBJECTIVE_APPLICATION_RESUME_WITNESS_SCHEMA,
    userId: record.userId,
    jobId: record.jobId,
    resumeId: record.resumeId,
    finalResumeAssignmentRevision: record.finalResumeAssignmentRevision,
    materialRevision: record.materialRevision,
    resumeMaterialHash: record.resumeMaterialHash,
  }
}

export function buildObjectiveApplicationResumeWitness(seed: WitnessSeed): ObjectiveApplicationResumeWitness | null {
  const record = exactRecord(seed, ["userId", "jobId", "resumeId", "finalResumeAssignmentRevision", "materialRevision", "material"])
  if (!record || !boundedId(record.userId) || !boundedId(record.jobId) || !boundedId(record.resumeId)
    || !revision(record.finalResumeAssignmentRevision) || !revision(record.materialRevision)) return null
  const material = exactRecord(record.material, MATERIAL_KEYS)
  if (!material || material.kind !== "adapted" || material.targetJobId !== record.jobId) return null
  const resumeMaterialHash = materialHash(record.material)
  if (!resumeMaterialHash) return null
  return parseObjectiveApplicationResumeWitness({
    schema: OBJECTIVE_APPLICATION_RESUME_WITNESS_SCHEMA,
    userId: record.userId,
    jobId: record.jobId,
    resumeId: record.resumeId,
    finalResumeAssignmentRevision: record.finalResumeAssignmentRevision,
    materialRevision: record.materialRevision,
    resumeMaterialHash,
  })
}

export function sameObjectiveApplicationResumeWitness(left: unknown, right: unknown): boolean {
  const a = parseObjectiveApplicationResumeWitness(left)
  const b = parseObjectiveApplicationResumeWitness(right)
  return a !== null && b !== null
    && a.userId === b.userId && a.jobId === b.jobId && a.resumeId === b.resumeId
    && a.finalResumeAssignmentRevision === b.finalResumeAssignmentRevision
    && a.materialRevision === b.materialRevision && a.resumeMaterialHash === b.resumeMaterialHash
}
