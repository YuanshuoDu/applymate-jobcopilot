import {
  SELECTED_JOB_BATCH_SLOT_IDS,
  selectedJobBatchTemplatesForSlot,
  type SelectedJobBatchSlotId,
} from "./selected-job-batch-templates.js"

export type SelectedJobBatchGraphNode = Readonly<{
  key: string
  templateId: string
  dependsOn: readonly string[]
}>
export type SelectedJobBatchGraphPair<T> = Readonly<{ writer: T; reviewer: T }>
export type SelectedJobBatchGraphSlot<T> = Readonly<{
  slotId: SelectedJobBatchSlotId
  initial: SelectedJobBatchGraphPair<T>
  correction?: SelectedJobBatchGraphPair<T>
  effective: SelectedJobBatchGraphPair<T>
}>

/** Parses the exact per-slot Writer → Reviewer chains and optional single correction chain. */
export function parseSelectedJobBatchGraph<T extends SelectedJobBatchGraphNode>(
  nodes: readonly T[], slotIds: readonly SelectedJobBatchSlotId[],
): readonly SelectedJobBatchGraphSlot<T>[] | null {
  if (!Array.isArray(nodes) || !Array.isArray(slotIds) || slotIds.length < 2
    || slotIds.length > SELECTED_JOB_BATCH_SLOT_IDS.length
    || slotIds.some((slotId, index) => slotId !== SELECTED_JOB_BATCH_SLOT_IDS[index])
    || nodes.length < slotIds.length * 2 || nodes.length > SELECTED_JOB_BATCH_SLOT_IDS.length * 2) return null

  const groups = new Map<SelectedJobBatchSlotId, { writers: T[]; reviewers: T[] }>()
  const templateSlots = new Map<string, { slotId: SelectedJobBatchSlotId; role: "writer" | "reviewer" }>()
  for (const slotId of slotIds) {
    const templates = selectedJobBatchTemplatesForSlot(slotId)
    if (!templates) return null
    groups.set(slotId, { writers: [], reviewers: [] })
    templateSlots.set(templates.writerTemplateId, { slotId, role: "writer" })
    templateSlots.set(templates.reviewerTemplateId, { slotId, role: "reviewer" })
  }

  const keys = new Set<string>()
  for (const node of nodes) {
    if (!node || typeof node !== "object" || typeof node.key !== "string" || !node.key.trim()
      || !Array.isArray(node.dependsOn) || !node.dependsOn.every((key: unknown) => typeof key === "string" && key.trim())
      || new Set(node.dependsOn).size !== node.dependsOn.length || keys.has(node.key)) return null
    const binding = templateSlots.get(node.templateId)
    if (!binding) return null
    keys.add(node.key)
    const group = groups.get(binding.slotId)!
    group[binding.role === "writer" ? "writers" : "reviewers"].push(node)
  }

  const result: SelectedJobBatchGraphSlot<T>[] = []
  for (const slotId of slotIds) {
    const group = groups.get(slotId)!
    if (group.writers.length !== group.reviewers.length || ![1, 2].includes(group.writers.length)) return null
    const initialWriters = group.writers.filter(node => node.dependsOn.length === 0)
    if (initialWriters.length !== 1) return null
    const initialWriter = initialWriters[0]!
    const initialReviewers = group.reviewers.filter(node => exactDependency(node, initialWriter.key))
    if (initialReviewers.length !== 1) return null
    const initialReviewer = initialReviewers[0]!
    const initial = Object.freeze({ writer: initialWriter, reviewer: initialReviewer })
    if (group.writers.length === 1) {
      result.push(Object.freeze({ slotId, initial, effective: initial }))
      continue
    }
    const correctionWriters = group.writers.filter(node => node !== initialWriter)
    const correctionReviewers = group.reviewers.filter(node => node !== initialReviewer)
    if (correctionWriters.length !== 1 || correctionReviewers.length !== 1
      || !exactDependency(correctionWriters[0]!, initialReviewer.key)
      || !exactDependency(correctionReviewers[0]!, correctionWriters[0]!.key)) return null
    const correction = Object.freeze({ writer: correctionWriters[0]!, reviewer: correctionReviewers[0]! })
    result.push(Object.freeze({ slotId, initial, correction, effective: correction }))
  }
  return result.length * 2 + result.filter(slot => slot.correction).length * 2 === nodes.length
    ? Object.freeze(result) : null
}

function exactDependency(node: SelectedJobBatchGraphNode, key: string): boolean {
  return node.dependsOn.length === 1 && node.dependsOn[0] === key
}
