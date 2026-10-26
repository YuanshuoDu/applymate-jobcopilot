import { Type } from "@sinclair/typebox"
import { TASK_GRAPH_LIMITS, type TaskGraphNodeProposal, type TaskGraphProposal } from "./task-graph.js"
import {
  taskGraphVerificationRole,
  validateTaskGraphVerificationContract,
  validateTaskGraphVerificationDependencySelectors,
  type TaskGraphVerificationContract,
} from "./task-graph-verification.js"
import type { TaskGraphVerificationDependencyGraphNode } from "./task-graph-verification-cross-node.js"
import { canonicalTaskGraphJson, parseTaskGraphSnapshot, type StoredTaskGraphNode, type TaskGraphSnapshot } from "../subagents/task-graph-snapshot.js"

const Id = Type.String({ minLength: 1, maxLength: TASK_GRAPH_LIMITS.maxKeyLength })
export const TaskGraphOperationalFailureReplacementInputSchema = Type.Object({
  root: Type.Object({ nodeKey: Id, taskId: Id }, { additionalProperties: false }),
  sources: Type.Array(Type.Object({ nodeKey: Id, taskId: Id, replacementKey: Id }, { additionalProperties: false }),
    { minItems: 1, maxItems: TASK_GRAPH_LIMITS.maxNodes }),
}, { additionalProperties: false })

export type TaskGraphOperationalFailureReplacement = Readonly<{
  root: Readonly<{ nodeKey: string; taskId: string }>
  sources: readonly Readonly<{ nodeKey: string; taskId: string; replacementKey: string }>[]
}>
export type TaskGraphOperationalFailureReplacementParse =
  | Readonly<{ ok: true; value: TaskGraphOperationalFailureReplacement }>
  | Readonly<{ ok: false; code: "task_graph_operational_failure_replacement_invalid" }>
export type TaskGraphOperationalFailureReplacementError =
  | "task_graph_operational_failure_replacement_invalid"
  | "task_graph_operational_failure_replacement_root_mismatch"
  | "task_graph_operational_failure_replacement_mapping_mismatch"
  | "task_graph_operational_failure_replacement_key_collision"
  | "task_graph_operational_failure_replacement_contract_mismatch"
  | "task_graph_operational_failure_replacement_repair_reference"
  | "task_graph_dependency_unverified"
export type ValidatedTaskGraphOperationalFailureReplacement = Readonly<{
  sourceNodes: readonly StoredTaskGraphNode[]
  sourceToReplacementKey: ReadonlyMap<string, string>
  replacementNodes: readonly TaskGraphNodeProposal[]
}>
export type TaskGraphOperationalFailureReplacementValidation =
  | Readonly<{ ok: true; value: ValidatedTaskGraphOperationalFailureReplacement }>
  | Readonly<{ ok: false; code: TaskGraphOperationalFailureReplacementError }>

function dataRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const keys = Reflect.ownKeys(value)
    if (keys.some(key => typeof key !== "string")) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of keys as string[]) {
      const descriptor = descriptors[key]
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined
      result[key] = descriptor.value
    }
    return result
  } catch { return undefined }
}
function exactRecord(value: unknown, keys: string): Record<string, unknown> | undefined {
  const row = dataRecord(value)
  return row && Object.keys(row).sort().join(",") === keys ? row : undefined
}
function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0
    && value.length <= TASK_GRAPH_LIMITS.maxKeyLength
}
function denseArray(value: unknown, minimum: number, maximum: number): unknown[] | undefined {
  try {
    if (!Array.isArray(value) || value.length < minimum || value.length > maximum) return undefined
    const keys = Reflect.ownKeys(value)
    if (keys.length !== value.length + 1) return undefined
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined
    }
    return value
  } catch { return undefined }
}

/** Parses the private mode separately from legacy branch replacement. */
export function parseTaskGraphOperationalFailureReplacement(
  value: unknown,
  proposalNodes?: readonly unknown[],
): TaskGraphOperationalFailureReplacementParse {
  const mode = exactRecord(value, "root,sources")
  const root = mode && exactRecord(mode.root, "nodeKey,taskId")
  const sources = mode && denseArray(mode.sources, 1, TASK_GRAPH_LIMITS.maxNodes)
  if (!mode || !root || !sources || !boundedText(root.nodeKey) || !boundedText(root.taskId)) {
    return { ok: false, code: "task_graph_operational_failure_replacement_invalid" }
  }
  const parsed: Array<{ nodeKey: string; taskId: string; replacementKey: string }> = []
  const sourceKeys = new Set<string>(), taskIds = new Set<string>(), replacementKeys = new Set<string>()
  for (const value of sources) {
    const source = exactRecord(value, "nodeKey,replacementKey,taskId")
    if (!source || !boundedText(source.nodeKey) || !boundedText(source.taskId) || !boundedText(source.replacementKey)
      || sourceKeys.has(source.nodeKey) || taskIds.has(source.taskId) || replacementKeys.has(source.replacementKey)) {
      return { ok: false, code: "task_graph_operational_failure_replacement_invalid" }
    }
    sourceKeys.add(source.nodeKey); taskIds.add(source.taskId); replacementKeys.add(source.replacementKey)
    parsed.push({ nodeKey: source.nodeKey, taskId: source.taskId, replacementKey: source.replacementKey })
  }
  if (!parsed.some(source => source.nodeKey === root.nodeKey && source.taskId === root.taskId)) {
    return { ok: false, code: "task_graph_operational_failure_replacement_invalid" }
  }
  if (proposalNodes !== undefined) {
    const proposed = denseArray(proposalNodes, 1, TASK_GRAPH_LIMITS.maxNodes)
    if (!proposed || proposed.length !== parsed.length) return { ok: false, code: "task_graph_operational_failure_replacement_invalid" }
    const keys: string[] = []
    for (const value of proposed) {
      const node = dataRecord(value)
      if (!node || !boundedText(node.key) || Object.hasOwn(node, "repairOf") || Object.hasOwn(node, "nativeDelegation")) {
        return { ok: false, code: "task_graph_operational_failure_replacement_invalid" }
      }
      keys.push(node.key)
    }
    if (new Set(keys).size !== keys.length || keys.some(key => !replacementKeys.has(key))) {
      return { ok: false, code: "task_graph_operational_failure_replacement_invalid" }
    }
  }
  return { ok: true, value: { root: { nodeKey: root.nodeKey, taskId: root.taskId }, sources: parsed } }
}

function remapVerification(contract: TaskGraphVerificationContract, mapping: ReadonlyMap<string, string>): TaskGraphVerificationContract {
  return {
    ...contract,
    criteria: contract.criteria.map(criterion => {
      const check = criterion.check
      if (check.kind !== "findings_from_scout_dependency" && check.kind !== "findings_cover_scout_candidates_gte") return criterion
      const dependencyNodeKey = mapping.get(check.dependencyNodeKey) ?? check.dependencyNodeKey
      return dependencyNodeKey === check.dependencyNodeKey ? criterion : { ...criterion, check: { ...check, dependencyNodeKey } }
    }),
  }
}
function hasLegacyDependencyAncestor(nodes: readonly TaskGraphVerificationDependencyGraphNode[], roots: readonly string[]): boolean {
  const byKey = new Map(nodes.map(node => [node.key, node] as const)), pending = [...roots], seen = new Set<string>()
  while (pending.length) {
    const key = pending.pop()!
    if (seen.has(key)) continue
    seen.add(key)
    const node = byKey.get(key)
    if (!node) continue
    if (node.verificationDisposition === "legacy_unverified") return true
    pending.push(...node.dependsOn)
  }
  return false
}

/** Validates a complete typed read-only failure closure without deciding failure authority. */
export function validateTaskGraphOperationalFailureReplacement(input: Readonly<{
  snapshot: TaskGraphSnapshot
  replaceOperationalFailure: TaskGraphOperationalFailureReplacement
  proposal: TaskGraphProposal
  proposedRootSuccessCriteria?: readonly string[]
}>): TaskGraphOperationalFailureReplacementValidation {
  const parsed = parseTaskGraphOperationalFailureReplacement(input.replaceOperationalFailure, input.proposal.nodes)
  if (!parsed.ok) return parsed
  let snapshot: TaskGraphSnapshot
  try { snapshot = parseTaskGraphSnapshot(input.snapshot) } catch {
    return { ok: false, code: "task_graph_operational_failure_replacement_invalid" }
  }
  const root = snapshot.nodes.find(node => node.key === parsed.value.root.nodeKey)
  if (!root || root.taskId !== parsed.value.root.taskId) return { ok: false, code: "task_graph_operational_failure_replacement_root_mismatch" }
  if (input.proposedRootSuccessCriteria !== undefined && snapshot.rootSuccessCriteria
    && canonicalTaskGraphJson(input.proposedRootSuccessCriteria) !== canonicalTaskGraphJson(snapshot.rootSuccessCriteria)) {
    return { ok: false, code: "task_graph_operational_failure_replacement_contract_mismatch" }
  }
  const closureKeys = new Set([root.key])
  let changed = true
  while (changed) {
    changed = false
    for (const node of snapshot.nodes) if (!closureKeys.has(node.key) && node.dependsOn.some(key => closureKeys.has(key))) {
      closureKeys.add(node.key); changed = true
    }
  }
  const closure = snapshot.nodes.filter(node => closureKeys.has(node.key))
  const sourceByKey = new Map(parsed.value.sources.map(source => [source.nodeKey, source] as const))
  if (closure.length !== parsed.value.sources.length || closure.some(node => sourceByKey.get(node.key)?.taskId !== node.taskId)) {
    return { ok: false, code: "task_graph_operational_failure_replacement_mapping_mismatch" }
  }
  const oldTaskIds = new Set(closure.map(node => node.taskId))
  if (closure.some(node => node.repairOf !== undefined || !taskGraphVerificationRole(node.templateId)
      || node.verificationDisposition !== "typed" || node.verification?.role !== taskGraphVerificationRole(node.templateId))
    || snapshot.nodes.some(node => !closureKeys.has(node.key) && node.repairOf
      && (closureKeys.has(node.repairOf.nodeKey) || oldTaskIds.has(node.repairOf.taskId)))) {
    return { ok: false, code: "task_graph_operational_failure_replacement_repair_reference" }
  }
  const existingKeys = new Set(snapshot.nodes.map(node => node.key)), mapping = new Map<string, string>()
  for (const source of parsed.value.sources) {
    if (existingKeys.has(source.replacementKey)) return { ok: false, code: "task_graph_operational_failure_replacement_key_collision" }
    mapping.set(source.nodeKey, source.replacementKey)
  }
  const replacementByKey = new Map(input.proposal.nodes.map(node => [node.key, node] as const))
  for (const source of closure) {
    const replacement = replacementByKey.get(mapping.get(source.key)!)
    const role = taskGraphVerificationRole(source.templateId)
    if (!replacement || !role || replacement.templateId !== source.templateId || replacement.repairOf !== undefined
      || Object.hasOwn(replacement, "nativeDelegation")) {
      return { ok: false, code: "task_graph_operational_failure_replacement_contract_mismatch" }
    }
    const expectedDependencies = source.dependsOn.map(key => mapping.get(key) ?? key)
    if (canonicalTaskGraphJson(replacement.dependsOn) !== canonicalTaskGraphJson(expectedDependencies)) {
      return { ok: false, code: "task_graph_operational_failure_replacement_contract_mismatch" }
    }
    const sourceContract = validateTaskGraphVerificationContract(source.verification, source.templateId)
    const replacementContract = validateTaskGraphVerificationContract(replacement.verification, replacement.templateId)
    if (canonicalTaskGraphJson(source.successCriteria) !== canonicalTaskGraphJson(replacement.successCriteria)
      || !sourceContract.ok || !replacementContract.ok
      || canonicalTaskGraphJson(remapVerification(sourceContract.contract, mapping)) !== canonicalTaskGraphJson(replacementContract.contract)) {
      return { ok: false, code: "task_graph_operational_failure_replacement_contract_mismatch" }
    }
  }
  const retained = snapshot.nodes.filter(node => !closureKeys.has(node.key))
  if (retained.some(node => node.dependsOn.some(key => closureKeys.has(key)))) {
    return { ok: false, code: "task_graph_operational_failure_replacement_mapping_mismatch" }
  }
  const combined: TaskGraphVerificationDependencyGraphNode[] = [
    ...retained.map(node => ({ key: node.key, templateId: node.templateId, dependsOn: node.dependsOn,
      verificationDisposition: node.verificationDisposition, verification: node.verification })),
    ...input.proposal.nodes.map(node => ({ key: node.key, templateId: node.templateId, dependsOn: node.dependsOn,
      verificationDisposition: "typed" as const, verification: node.verification })),
  ]
  const allKeys = new Set(combined.map(node => node.key))
  if (combined.some(node => node.dependsOn.some(key => !allKeys.has(key)))
    || !validateTaskGraphVerificationDependencySelectors(combined)) {
    return { ok: false, code: "task_graph_operational_failure_replacement_contract_mismatch" }
  }
  if (hasLegacyDependencyAncestor(combined, input.proposal.nodes.flatMap(node => node.dependsOn))) {
    return { ok: false, code: "task_graph_dependency_unverified" }
  }
  return { ok: true, value: { sourceNodes: closure, sourceToReplacementKey: mapping, replacementNodes: input.proposal.nodes } }
}
