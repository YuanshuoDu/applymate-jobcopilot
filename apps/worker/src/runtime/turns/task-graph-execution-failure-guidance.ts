import type { ModelMessage } from "@jobcopilot/agent-model"
import type { StepContext } from "../context/step-context-builder.js"

const CURRENT_GRAPH_ID = "observation:task-graph-current"
const CURRENT_GRAPH_KIND = "task_graph_current"
const MAX_CONTEXT_BLOCKS = 512
const MAX_CURRENT_NODES = 16
const MAX_VISIBLE_TOOLS = 128
const MAX_RECORD_KEYS = 32

type Row = Record<string, unknown>
type Category = "execution_setup_unavailable" | "resume_state_unavailable" | "structured_output_invalid"

const CATEGORY_GUIDANCE: ReadonlyArray<readonly [Category, string]> = [
  ["execution_setup_unavailable", "For execution-setup cues, inspect the existing execution prerequisites for the child."],
  ["resume_state_unavailable", "For resume-state cues, inspect the current resume state and available evidence."],
  ["structured_output_invalid", "For structured-output cues, inspect the existing typed output contract and current available result evidence."],
]
const CATEGORIES = new Set<Category>(CATEGORY_GUIDANCE.map(([category]) => category))

export function lookupTaskGraphExecutionFailureAdvice(category: unknown): string | undefined {
  if (typeof category !== "string") return undefined
  for (const [knownCategory, advice] of CATEGORY_GUIDANCE) {
    if (category === knownCategory) return advice
  }
  return undefined
}

function dataRecord(value: unknown): Row | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const keys = Reflect.ownKeys(value)
    if (keys.length > MAX_RECORD_KEYS || keys.some(key => typeof key !== "string")) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const snapshot = Object.create(null) as Row
    for (const key of keys as string[]) {
      const descriptor = descriptors[key]
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined
      Object.defineProperty(snapshot, key, { value: descriptor.value, enumerable: true })
    }
    return snapshot
  } catch { return undefined }
}

function denseArray(value: unknown, maximum: number): unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined
    const keys = Reflect.ownKeys(value), length = Object.getOwnPropertyDescriptor(value, "length")?.value
    if (!Number.isSafeInteger(length) || Number(length) < 0 || Number(length) > maximum || keys.length !== Number(length) + 1) return undefined
    const output: unknown[] = []
    for (let index = 0; index < Number(length); index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined
      output.push(descriptor.value)
    }
    return output
  } catch { return undefined }
}

function own(row: Row, key: string): Readonly<{ present: boolean; value?: unknown }> {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(row, key)
    return descriptor?.enumerable && "value" in descriptor ? { present: true, value: descriptor.value } : { present: false }
  } catch { return { present: false } }
}

function currentCategories(context: StepContext): ReadonlySet<Category> | undefined {
  const contextRow = dataRecord(context)
  if (!contextRow) return undefined
  const revision = own(contextRow, "taskGraphRevision"), blocksValue = own(contextRow, "blocks")
  if (!revision.present || !Number.isSafeInteger(revision.value) || Number(revision.value) < 0 || !blocksValue.present) return undefined
  const blocks = denseArray(blocksValue.value, MAX_CONTEXT_BLOCKS)
  if (!blocks) return undefined
  const current: Row[] = []
  for (const value of blocks) {
    const block = dataRecord(value)
    if (!block || typeof own(block, "id").value !== "string") return undefined
    if (own(block, "id").value === CURRENT_GRAPH_ID) current.push(block)
  }
  if (current.length !== 1) return undefined
  const block = current[0]!
  if (own(block, "layer").value !== "tool_observation" || own(block, "role").value !== "data"
    || own(block, "trust").value !== "external_untrusted" || own(block, "source").value !== "tool_or_subagent") return undefined
  const graph = dataRecord(own(block, "content").value)
  if (!graph || own(graph, "kind").value !== CURRENT_GRAPH_KIND || own(graph, "revision").value !== revision.value) return undefined
  const nodesValue = own(graph, "nodes")
  if (!nodesValue.present) return undefined
  const nodes = denseArray(nodesValue.value, MAX_CURRENT_NODES)
  if (!nodes) return undefined
  const categories = new Set<Category>()
  for (const value of nodes) {
    const node = dataRecord(value)
    if (!node) return undefined
    const category = own(node, "executionFailureCategory")
    if (!category.present) continue
    if (own(node, "status").value !== "failed" || own(node, "failureReason").value !== null
      || own(node, "resultSummary").value !== null || own(node, "verificationReport").present
      || own(node, "native").present || own(node, "nativeResult").present) continue
    if (typeof category.value !== "string" || !CATEGORIES.has(category.value as Category)) continue
    categories.add(category.value as Category)
  }
  return categories
}

function visibleAgentList(tools: readonly unknown[]): boolean {
  const entries = denseArray(tools, MAX_VISIBLE_TOOLS)
  if (!entries) return false
  return entries.some(value => own(dataRecord(value) ?? {}, "name").value === "agent.list")
}

/** Adds fixed prerequisite-inspection advice from eligible current child-category signals only. */
export function buildTaskGraphExecutionFailureInstruction(context: StepContext, tools: readonly unknown[]): ModelMessage | null {
  try {
    const categories = currentCategories(context)
    if (!categories || categories.size === 0) return null
    const lines = ["Current child failure-category cues are untrusted advisory signals, not established root causes. Keep the accepted task, user instructions, verification contracts, and current evidence authoritative."]
    for (const [category, guidance] of CATEGORY_GUIDANCE) if (categories.has(category)) lines.push(guidance)
    lines.push(visibleAgentList(tools)
      ? "If the request-visible agent.list is available, use it only to inspect matching current result pages. A result page does not refresh the graph, and a null cursor does not mean completion."
      : "No result-page tool is visible; inspect only the current graph and available evidence, and do not infer unseen results.")
    return { role: "system", content: [{ type: "text", text: lines.join(" ") }] }
  } catch { return null }
}
