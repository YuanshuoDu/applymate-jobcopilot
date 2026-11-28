import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import type { VerifiedTaskGraphFailedBranchReplacementMemoryWitness } from "../subagents/steering-reconciliation-failed-branch-proof-readers.js"

export const ROOT_TASK_HISTORY_BRANCH_REPLACEMENT_EPISODE_SCHEMA_VERSION =
  "agent-harness.v2.root-task-history-branch-replacement-episode.v1" as const

export type RootTaskHistoryBranchReplacementEpisode = Readonly<{
  schemaVersion: typeof ROOT_TASK_HISTORY_BRANCH_REPLACEMENT_EPISODE_SCHEMA_VERSION
  reason: "result_invalid"
  failedRole: "scout"
  replacedRoles: Readonly<{ scout: number; analyst: number; writer: number; reviewer: number; other: number }>
  successorRoles: Readonly<{ scout: number; analyst: number; writer: number; reviewer: number; other: number }>
}>

type Row = Record<string, unknown>
type RoleCounts = RootTaskHistoryBranchReplacementEpisode["replacedRoles"]
const ROLES = ["scout", "analyst", "writer", "reviewer", "other"] as const

function sameCounts(left: RoleCounts, right: RoleCounts): boolean { return ROLES.every(role => left[role] === right[role]) }

function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).every(key => typeof key === "string"
      && descriptors[key]?.enumerable && "value" in descriptors[key]!) ? value as Row : null
  } catch { return null }
}

function exact(value: Row, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(value)
  return own.length === keys.length && own.every(key => typeof key === "string" && keys.includes(key))
}

function taskKind(templateId: string): keyof RoleCounts {
  return templateId === "scout" || templateId === "analyst" ? templateId
    : templateId === "cover_letter_writer" ? "writer"
      : templateId === "cover_letter_reviewer" ? "reviewer" : "other"
}

function counts(templateIds: readonly string[]): RoleCounts | null {
  if (templateIds.length < 1 || templateIds.length > TASK_GRAPH_LIMITS.maxNodes) return null
  const result: Record<keyof RoleCounts, number> = { scout: 0, analyst: 0, writer: 0, reviewer: 0, other: 0 }
  for (const id of templateIds) {
    if (typeof id !== "string" || id.length < 1 || id.length > 128) return null
    result[taskKind(id)] += 1
  }
  return result
}

function safeTemplateIds(value: unknown): readonly string[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1
      || value.length < 1 || value.length > TASK_GRAPH_LIMITS.maxNodes) return null
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      return descriptor?.enumerable && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : null
    }).every((entry): entry is string => entry !== null) ? value as readonly string[] : null
  } catch { return null }
}

function parseCounts(value: unknown, source: boolean): RoleCounts | null {
  const row = record(value)
  if (!row || !exact(row, ROLES)) return null
  const counts = Object.fromEntries(ROLES.map(role => [role, row[role]])) as Record<keyof RoleCounts, unknown>
  if (ROLES.some(role => !Number.isSafeInteger(counts[role]) || Number(counts[role]) < 0
    || Number(counts[role]) > TASK_GRAPH_LIMITS.maxNodes)) return null
  const total = ROLES.reduce((sum, role) => sum + Number(counts[role]), 0)
  if (source ? total < 2 || total > TASK_GRAPH_LIMITS.maxNodes || Number(counts.scout) < 1
    || Number(counts.writer) !== 0 || Number(counts.reviewer) !== 0 || Number(counts.other) !== 0
    : total < 1 || total > TASK_GRAPH_LIMITS.maxNodes) return null
  return Object.fromEntries(ROLES.map(role => [role, Number(counts[role])])) as RoleCounts
}

export function projectRootTaskHistoryBranchReplacementEpisode(
  witness: VerifiedTaskGraphFailedBranchReplacementMemoryWitness,
): RootTaskHistoryBranchReplacementEpisode | null {
  const sourceTemplates = safeTemplateIds(witness?.sourceTemplateIds), successorTemplates = safeTemplateIds(witness?.successorTemplateIds)
  if (!witness || witness.reason !== "result_invalid" || !sourceTemplates || !successorTemplates) return null
  const replacedRoles = counts(sourceTemplates), successorRoles = counts(successorTemplates)
  if (!replacedRoles || !successorRoles || replacedRoles.scout < 1 || replacedRoles.writer !== 0
    || replacedRoles.reviewer !== 0 || replacedRoles.other !== 0 || !sameCounts(replacedRoles, successorRoles)) return null
  return { schemaVersion: ROOT_TASK_HISTORY_BRANCH_REPLACEMENT_EPISODE_SCHEMA_VERSION,
    reason: "result_invalid", failedRole: "scout", replacedRoles, successorRoles }
}

export function parseRootTaskHistoryBranchReplacementEpisode(value: unknown): RootTaskHistoryBranchReplacementEpisode | null {
  try {
    const row = record(value)
    if (!row || !exact(row, ["schemaVersion", "reason", "failedRole", "replacedRoles", "successorRoles"])
      || row.schemaVersion !== ROOT_TASK_HISTORY_BRANCH_REPLACEMENT_EPISODE_SCHEMA_VERSION
      || row.reason !== "result_invalid" || row.failedRole !== "scout") return null
    const replacedRoles = parseCounts(row.replacedRoles, true), successorRoles = parseCounts(row.successorRoles, false)
    return replacedRoles && successorRoles && sameCounts(replacedRoles, successorRoles)
      ? { schemaVersion: ROOT_TASK_HISTORY_BRANCH_REPLACEMENT_EPISODE_SCHEMA_VERSION, reason: "result_invalid",
        failedRole: "scout", replacedRoles, successorRoles }
      : null
  } catch { return null }
}
