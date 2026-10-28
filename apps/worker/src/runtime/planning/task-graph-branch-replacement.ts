import { Type } from "@sinclair/typebox"
import { TASK_GRAPH_LIMITS, type TaskGraphNodeProposal, type TaskGraphProposal } from "./task-graph.js"
import {
  taskGraphVerificationRole,
  validateTaskGraphVerificationContract,
  validateTaskGraphVerificationDependencySelectors,
  type TaskGraphVerificationContract,
} from "./task-graph-verification.js"
import { remapTaskGraphVerificationCheckDependencies } from "./task-graph-verification-scout-union.js"
import type { TaskGraphVerificationDependencyGraphNode } from "./task-graph-verification-cross-node.js"
import { canonicalTaskGraphJson, parseTaskGraphSnapshot, type StoredTaskGraphNode, type TaskGraphSnapshot } from "../subagents/task-graph-snapshot.js"

const Id = Type.String({ minLength: 1, maxLength: TASK_GRAPH_LIMITS.maxKeyLength })
export const TaskGraphBranchReplacementInputSchema = Type.Object({
  root: Type.Object({ nodeKey: Id, taskId: Id }, { additionalProperties: false }),
  sources: Type.Array(Type.Object({ nodeKey: Id, taskId: Id, replacementKey: Id }, { additionalProperties: false }),
    { minItems: 2, maxItems: TASK_GRAPH_LIMITS.maxNodes }),
}, { additionalProperties: false })

export type TaskGraphBranchReplacement = Readonly<{
  root: Readonly<{ nodeKey: string; taskId: string }>
  sources: readonly Readonly<{ nodeKey: string; taskId: string; replacementKey: string }>[]
}>

export type TaskGraphBranchReplacementError =
  | "task_graph_branch_replacement_invalid"
  | "task_graph_branch_replacement_root_mismatch"
  | "task_graph_branch_replacement_mapping_mismatch"
  | "task_graph_branch_replacement_key_collision"
  | "task_graph_branch_replacement_contract_mismatch"
  | "task_graph_branch_replacement_repair_reference"
  | "task_graph_dependency_unverified"

export type TaskGraphBranchReplacementParse =
  | Readonly<{ ok: true; value: TaskGraphBranchReplacement }>
  | Readonly<{ ok: false; code: "task_graph_branch_replacement_invalid" }>

export type ValidatedTaskGraphBranchReplacement = Readonly<{
  sourceNodes: readonly StoredTaskGraphNode[]
  sourceToReplacementKey: ReadonlyMap<string, string>
  replacementNodes: readonly TaskGraphNodeProposal[]
}>

export type TaskGraphBranchReplacementValidation =
  | Readonly<{ ok: true; value: ValidatedTaskGraphBranchReplacement }>
  | Readonly<{ ok: false; code: TaskGraphBranchReplacementError }>

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}

function exactRecord(value: unknown, keys: string): Record<string, unknown> | undefined {
  const record = plainRecord(value)
  if (!record) return undefined
  try {
    const ownKeys = Reflect.ownKeys(value as object)
    return ownKeys.every((key): key is string => typeof key === "string")
      && ownKeys.sort().join(",") === keys ? record : undefined
  } catch { return undefined }
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0
    && value.length <= TASK_GRAPH_LIMITS.maxKeyLength
}

/** Checks the immutable request shape before it reaches the command port. */
export function parseTaskGraphBranchReplacement(value: unknown, proposalNodes?: readonly Readonly<{ key: string; repairOf?: unknown }>[]): TaskGraphBranchReplacementParse {
  const branch = exactRecord(value, "root,sources"), root = branch && exactRecord(branch.root, "nodeKey,taskId")
  if (!branch || !root || !boundedText(root.nodeKey) || !boundedText(root.taskId) || !Array.isArray(branch.sources)
    || branch.sources.length < 2 || branch.sources.length > TASK_GRAPH_LIMITS.maxNodes) {
    return { ok: false, code: "task_graph_branch_replacement_invalid" }
  }
  const ownKeys = Reflect.ownKeys(branch.sources)
  if (ownKeys.length !== branch.sources.length + 1 || ownKeys.some((key, index) => key !== "length" && key !== String(index))) {
    return { ok: false, code: "task_graph_branch_replacement_invalid" }
  }
  const sources: Array<{ nodeKey: string; taskId: string; replacementKey: string }> = []
  const sourceKeys = new Set<string>(), taskIds = new Set<string>(), replacementKeys = new Set<string>()
  for (const item of branch.sources) {
    const source = exactRecord(item, "nodeKey,replacementKey,taskId")
    if (!source || !boundedText(source.nodeKey) || !boundedText(source.taskId) || !boundedText(source.replacementKey)
      || sourceKeys.has(source.nodeKey) || taskIds.has(source.taskId) || replacementKeys.has(source.replacementKey)) {
      return { ok: false, code: "task_graph_branch_replacement_invalid" }
    }
    sourceKeys.add(source.nodeKey); taskIds.add(source.taskId); replacementKeys.add(source.replacementKey)
    sources.push({ nodeKey: source.nodeKey, taskId: source.taskId, replacementKey: source.replacementKey })
  }
  if (!sources.some(source => source.nodeKey === root.nodeKey && source.taskId === root.taskId)) {
    return { ok: false, code: "task_graph_branch_replacement_invalid" }
  }
  if (proposalNodes) {
    if (!Array.isArray(proposalNodes) || proposalNodes.length > TASK_GRAPH_LIMITS.maxNodes
      || proposalNodes.some(node => !plainRecord(node) || !boundedText(node.key))) {
      return { ok: false, code: "task_graph_branch_replacement_invalid" }
    }
    const proposedKeys = proposalNodes.map(node => node.key)
    if (proposedKeys.length !== sources.length || new Set(proposedKeys).size !== proposedKeys.length
      || proposedKeys.some(key => !replacementKeys.has(key)) || proposalNodes.some(node => node.repairOf !== undefined)) {
      return { ok: false, code: "task_graph_branch_replacement_invalid" }
    }
  }
  return { ok: true, value: { root: { nodeKey: root.nodeKey, taskId: root.taskId }, sources } }
}

function remapVerification(contract: TaskGraphVerificationContract, mapping: ReadonlyMap<string, string>): TaskGraphVerificationContract {
  return {
    ...contract,
    criteria: contract.criteria.map(criterion => ({ ...criterion,
      check: remapTaskGraphVerificationCheckDependencies(criterion.check, mapping) })),
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

/** Validates a complete replacement against the locked, current graph snapshot. */
export function validateTaskGraphBranchReplacement(input: Readonly<{
  snapshot: TaskGraphSnapshot
  replaceBranch: TaskGraphBranchReplacement
  proposal: TaskGraphProposal
  proposedRootSuccessCriteria?: readonly string[]
}>): TaskGraphBranchReplacementValidation {
  const parsed = parseTaskGraphBranchReplacement(input.replaceBranch, input.proposal.nodes)
  if (!parsed.ok) return parsed
  let snapshot: TaskGraphSnapshot
  try { snapshot = parseTaskGraphSnapshot(input.snapshot) } catch {
    return { ok: false, code: "task_graph_branch_replacement_invalid" }
  }
  const root = snapshot.nodes.find(node => node.key === parsed.value.root.nodeKey)
  if (!root || root.taskId !== parsed.value.root.taskId) {
    return { ok: false, code: "task_graph_branch_replacement_root_mismatch" }
  }
  if (input.proposedRootSuccessCriteria !== undefined
    && (!snapshot.rootSuccessCriteria || canonicalTaskGraphJson(input.proposedRootSuccessCriteria) !== canonicalTaskGraphJson(snapshot.rootSuccessCriteria))) {
    return { ok: false, code: "task_graph_branch_replacement_contract_mismatch" }
  }
  const closureKeys = new Set([root.key])
  let changed = true
  while (changed) {
    changed = false
    for (const node of snapshot.nodes) if (!closureKeys.has(node.key) && node.dependsOn.some(key => closureKeys.has(key))) {
      closureKeys.add(node.key); changed = true
    }
  }
  if (closureKeys.size < 2) return { ok: false, code: "task_graph_branch_replacement_mapping_mismatch" }
  const closure = snapshot.nodes.filter(node => closureKeys.has(node.key))
  const sourceByKey = new Map(parsed.value.sources.map(source => [source.nodeKey, source] as const))
  if (closure.length !== parsed.value.sources.length || closure.some(node => sourceByKey.get(node.key)?.taskId !== node.taskId)) {
    return { ok: false, code: "task_graph_branch_replacement_mapping_mismatch" }
  }
  const oldTaskIds = new Set(closure.map(node => node.taskId))
  if (closure.some(node => node.repairOf !== undefined)
    || snapshot.nodes.some(node => !closureKeys.has(node.key) && node.repairOf
      && (closureKeys.has(node.repairOf.nodeKey) || oldTaskIds.has(node.repairOf.taskId)))) {
    return { ok: false, code: "task_graph_branch_replacement_repair_reference" }
  }
  const existingKeys = new Set(snapshot.nodes.map(node => node.key))
  const mapping = new Map<string, string>()
  for (const source of parsed.value.sources) {
    if (existingKeys.has(source.replacementKey)) return { ok: false, code: "task_graph_branch_replacement_key_collision" }
    mapping.set(source.nodeKey, source.replacementKey)
  }
  const replacementByKey = new Map(input.proposal.nodes.map(node => [node.key, node] as const))
  for (const source of closure) {
    const replacement = replacementByKey.get(mapping.get(source.key)!)
    const role = taskGraphVerificationRole(source.templateId)
    if (!replacement || !role || source.verificationDisposition !== "typed" || source.verification?.role !== role
      || replacement.templateId !== source.templateId || replacement.repairOf !== undefined) {
      return { ok: false, code: "task_graph_branch_replacement_contract_mismatch" }
    }
    const expectedDependencies = source.dependsOn.map(key => mapping.get(key) ?? key)
    if (canonicalTaskGraphJson(replacement.dependsOn) !== canonicalTaskGraphJson(expectedDependencies)) {
      return { ok: false, code: "task_graph_branch_replacement_contract_mismatch" }
    }
    const sourceContract = validateTaskGraphVerificationContract(source.verification, source.templateId)
    const replacementContract = validateTaskGraphVerificationContract(replacement.verification, replacement.templateId)
    if (!sourceContract.ok || !replacementContract.ok
      || canonicalTaskGraphJson(remapVerification(sourceContract.contract, mapping)) !== canonicalTaskGraphJson(replacementContract.contract)) {
      return { ok: false, code: "task_graph_branch_replacement_contract_mismatch" }
    }
  }
  const retained = snapshot.nodes.filter(node => !closureKeys.has(node.key))
  if (retained.some(node => node.dependsOn.some(key => closureKeys.has(key)))) {
    return { ok: false, code: "task_graph_branch_replacement_mapping_mismatch" }
  }
  const combined: TaskGraphVerificationDependencyGraphNode[] = [
    ...retained.map(node => ({ key: node.key, templateId: node.templateId, dependsOn: node.dependsOn,
      verificationDisposition: node.verificationDisposition, verification: node.verification })),
    ...input.proposal.nodes.map(node => ({ key: node.key, templateId: node.templateId, dependsOn: node.dependsOn,
      verificationDisposition: "typed", verification: node.verification })),
  ]
  const allKeys = new Set(combined.map(node => node.key))
  if (combined.some(node => node.dependsOn.some(key => !allKeys.has(key)))
    || !validateTaskGraphVerificationDependencySelectors(combined)) {
    return { ok: false, code: "task_graph_branch_replacement_contract_mismatch" }
  }
  if (hasLegacyDependencyAncestor(combined, input.proposal.nodes.flatMap(node => node.dependsOn))) {
    return { ok: false, code: "task_graph_dependency_unverified" }
  }
  return { ok: true, value: { sourceNodes: closure, sourceToReplacementKey: mapping, replacementNodes: input.proposal.nodes } }
}
