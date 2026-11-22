export const SELECTED_JOB_BATCH_SLOT_IDS = ["slot-1", "slot-2", "slot-3", "slot-4"] as const
export type SelectedJobBatchSlotId = typeof SELECTED_JOB_BATCH_SLOT_IDS[number]

/** Finite specialized templates used only by the selected-job batch graph. */
export const SELECTED_JOB_BATCH_TEMPLATE_CATALOG = Object.freeze([
  Object.freeze({ slotId: SELECTED_JOB_BATCH_SLOT_IDS[0], writerTemplateId: "cover_letter_writer_slot_1", reviewerTemplateId: "cover_letter_reviewer_slot_1" }),
  Object.freeze({ slotId: SELECTED_JOB_BATCH_SLOT_IDS[1], writerTemplateId: "cover_letter_writer_slot_2", reviewerTemplateId: "cover_letter_reviewer_slot_2" }),
  Object.freeze({ slotId: SELECTED_JOB_BATCH_SLOT_IDS[2], writerTemplateId: "cover_letter_writer_slot_3", reviewerTemplateId: "cover_letter_reviewer_slot_3" }),
  Object.freeze({ slotId: SELECTED_JOB_BATCH_SLOT_IDS[3], writerTemplateId: "cover_letter_writer_slot_4", reviewerTemplateId: "cover_letter_reviewer_slot_4" }),
] as const)

export type SelectedJobBatchTemplateEntry = typeof SELECTED_JOB_BATCH_TEMPLATE_CATALOG[number]
export type SelectedJobBatchTemplateId = SelectedJobBatchTemplateEntry["writerTemplateId" | "reviewerTemplateId"]

export function selectedJobBatchTemplatesForSlot(value: unknown): SelectedJobBatchTemplateEntry | null {
  return SELECTED_JOB_BATCH_TEMPLATE_CATALOG.find(entry => entry.slotId === value) ?? null
}

export function isSelectedJobBatchTemplateId(value: unknown): value is SelectedJobBatchTemplateId {
  return typeof value === "string" && SELECTED_JOB_BATCH_TEMPLATE_CATALOG.some(entry =>
    entry.writerTemplateId === value || entry.reviewerTemplateId === value)
}
