import { isProxy } from "node:util/types"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { redactSensitiveValue } from "@jobcopilot/shared"
import { NESTED_SCOUT_ALLOWED_SOURCES } from "../subagents/nested-scout-profile.js"
import { isCanonicalJobId } from "./job-read-output-redaction.js"

const MAX_CHILDREN = 2
const MAX_CANDIDATES = 20
const MAX_TEXT_LENGTH = 256
const TERMINAL_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled", "closed"])

type Candidate = Readonly<{ jobId: string; source: string }>
type Child = Readonly<{ taskId: string; status: string; candidates: readonly Candidate[] }>
type JsonRecord = { readonly [key: string]: RepositoryJsonValue }

/** Preserves canonical Job IDs only inside a verified nested Scout results projection. */
export function prepareScoutResultsOutput(value: unknown): RepositoryJsonValue | null {
  try {
    const children = readAvailableChildren(value)
    if (!children) return null
    const safe = redactSensitiveValue(value)
    if (!isJsonRecord(safe) || !Array.isArray(safe.children) || safe.children.length !== children.length) return null

    const safeChildren: RepositoryJsonValue[] = []
    for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
      const sourceChild = children[childIndex]!
      const safeChild = safe.children[childIndex]
      if (!isJsonRecord(safeChild) || !Array.isArray(safeChild.candidates)
        || safeChild.candidates.length !== sourceChild.candidates.length) return null
      const safeCandidates: RepositoryJsonValue[] = []
      for (let candidateIndex = 0; candidateIndex < sourceChild.candidates.length; candidateIndex += 1) {
        const candidate = sourceChild.candidates[candidateIndex]!
        const safeCandidate = safeChild.candidates[candidateIndex]
        if (!isJsonRecord(safeCandidate)) return null
        safeCandidates.push({ ...safeCandidate,
          ...(isCanonicalJobId(candidate.jobId) ? { jobId: candidate.jobId } : {}) })
      }
      safeChildren.push({ ...safeChild, candidates: safeCandidates })
    }
    return { ...safe, children: safeChildren }
  } catch {
    return null
  }
}

function readAvailableChildren(value: unknown): Child[] | null {
  const root = plainRecord(value)
  if (!root || !exactKeys(root, ["availability", "children"]) || root.availability !== "available"
    || !denseArray(root.children, MAX_CHILDREN)) return null
  const children: Child[] = []
  const childIds = new Set<string>()
  let candidateCount = 0
  for (const value of root.children) {
    const row = plainRecord(value)
    if (!row || !exactKeys(row, ["taskId", "status", "candidates"]) || !boundedText(row.taskId, MAX_TEXT_LENGTH)
      || typeof row.status !== "string" || row.status.length === 0 || row.status.length > 32
      || !TERMINAL_STATUSES.has(row.status) || !denseArray(row.candidates, MAX_CANDIDATES)) return null
    if (childIds.has(row.taskId)) return null
    childIds.add(row.taskId)
    const candidates: Candidate[] = []
    for (const candidateValue of row.candidates) {
      const candidate = plainRecord(candidateValue)
      if (!candidate || !exactKeys(candidate, ["jobId", "source"]) || !boundedText(candidate.jobId, MAX_TEXT_LENGTH)
        || typeof candidate.source !== "string" || !NESTED_SCOUT_ALLOWED_SOURCES.includes(candidate.source as typeof NESTED_SCOUT_ALLOWED_SOURCES[number])) return null
      candidates.push({ jobId: candidate.jobId, source: candidate.source })
      candidateCount += 1
      if (candidateCount > MAX_CANDIDATES) return null
    }
    if (row.status !== "completed" && candidates.length > 0) return null
    children.push({ taskId: row.taskId, status: row.status, candidates })
  }
  return children
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value)
  if (actual.length !== keys.length || actual.some(key => typeof key !== "string" || !keys.includes(key))) return false
  return keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return !!descriptor && descriptor.enumerable && "value" in descriptor
  })
}

function denseArray(value: unknown, maximum: number): value is unknown[] {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return false
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1 || !keys.includes("length")) return false
  return keys.every(key => {
    if (key === "length") return true
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return !!descriptor && descriptor.enumerable && "value" in descriptor
  })
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
}

function isJsonRecord(value: RepositoryJsonValue): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
