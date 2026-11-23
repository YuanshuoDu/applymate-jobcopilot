import { TASK_GRAPH_MAX_IDENTIFIER_LENGTH } from "./plan-ledger.js"

export const TASK_GRAPH_MAX_PROPOSAL_NODES = 8
export const TASK_GRAPH_BRANCH_KEY_MAX_LENGTH = TASK_GRAPH_MAX_IDENTIFIER_LENGTH

type Row = Record<string, unknown>

export type TaskGraphBranchReplacementContract = Readonly<{
  root: Readonly<{ nodeKey: string; taskId: string }>
  sources: readonly Readonly<{ nodeKey: string; taskId: string; replacementKey: string }>[]
}>

export type TaskGraphBranchReplacementContractParse =
  | Readonly<{ ok: true; value: TaskGraphBranchReplacementContract }>
  | Readonly<{ ok: false; code: "task_graph_branch_replacement_invalid" }>

function plainRecord(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    return (prototype === Object.prototype || prototype === null)
      && Reflect.ownKeys(value).every(key => typeof key === "string"
        && descriptors[key]?.enumerable && "value" in descriptors[key]!)
      ? value as Row : null
  } catch { return null }
}

function exactRecord(value: unknown, keys: readonly string[]): Row | null {
  const row = plainRecord(value)
  if (!row) return null
  try {
    const actual = Reflect.ownKeys(value as object)
    return actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key)) ? row : null
  } catch { return null }
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0
    && value.length <= TASK_GRAPH_BRANCH_KEY_MAX_LENGTH
}

function denseArray(value: unknown, maxLength: number): value is unknown[] {
  if (!Array.isArray(value) || value.length > maxLength) return false
  try {
    const keys = Reflect.ownKeys(value)
    return keys.length === value.length + 1
      && keys.every((key, index) => key === "length" || key === String(index))
  } catch { return false }
}

/** Parses the closed branch request shared by Worker admission and receipt validation. */
export function parseTaskGraphBranchReplacementContract(
  value: unknown,
  proposalNodes?: readonly Readonly<{ key: string; repairOf?: unknown }>[],
): TaskGraphBranchReplacementContractParse {
  try {
    const branch = exactRecord(value, ["root", "sources"])
    const root = branch && exactRecord(branch.root, ["nodeKey", "taskId"])
    if (!branch || !root || !boundedText(root.nodeKey) || !boundedText(root.taskId)
      || !denseArray(branch.sources, TASK_GRAPH_MAX_PROPOSAL_NODES) || branch.sources.length < 2) return invalid()

    const sources: Array<{ nodeKey: string; taskId: string; replacementKey: string }> = []
    const sourceKeys = new Set<string>(), taskIds = new Set<string>(), replacementKeys = new Set<string>()
    for (const item of branch.sources) {
      const source = exactRecord(item, ["nodeKey", "taskId", "replacementKey"])
      if (!source || !boundedText(source.nodeKey) || !boundedText(source.taskId) || !boundedText(source.replacementKey)
        || sourceKeys.has(source.nodeKey) || taskIds.has(source.taskId) || replacementKeys.has(source.replacementKey)) return invalid()
      sourceKeys.add(source.nodeKey)
      taskIds.add(source.taskId)
      replacementKeys.add(source.replacementKey)
      sources.push({ nodeKey: source.nodeKey, taskId: source.taskId, replacementKey: source.replacementKey })
    }
    if (!sources.some(source => source.nodeKey === root.nodeKey && source.taskId === root.taskId)) return invalid()

    if (proposalNodes !== undefined) {
      if (!Array.isArray(proposalNodes) || proposalNodes.length > TASK_GRAPH_MAX_PROPOSAL_NODES
        || proposalNodes.some(node => !plainRecord(node) || !boundedText(node.key))) return invalid()
      const proposedKeys = proposalNodes.map(node => node.key)
      if (proposedKeys.length !== sources.length || new Set(proposedKeys).size !== proposedKeys.length
        || proposedKeys.some(key => !replacementKeys.has(key)) || proposalNodes.some(node => node.repairOf !== undefined)) return invalid()
    }
    return { ok: true, value: { root: { nodeKey: root.nodeKey, taskId: root.taskId }, sources } }
  } catch { return invalid() }
}

function invalid(): TaskGraphBranchReplacementContractParse {
  return { ok: false, code: "task_graph_branch_replacement_invalid" }
}
