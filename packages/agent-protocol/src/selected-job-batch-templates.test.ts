import { describe, expect, it } from "vitest"

import {
  isSelectedJobBatchTemplateId,
  SELECTED_JOB_BATCH_SLOT_IDS,
  SELECTED_JOB_BATCH_TEMPLATE_CATALOG,
  selectedJobBatchTemplatesForSlot,
} from "./selected-job-batch-templates.js"

describe("selected-job batch template catalog", () => {
  it("maps each finite slot to its exact Writer and Reviewer template IDs", () => {
    expect(SELECTED_JOB_BATCH_TEMPLATE_CATALOG.map(entry => entry.slotId)).toEqual(SELECTED_JOB_BATCH_SLOT_IDS)
    expect(SELECTED_JOB_BATCH_TEMPLATE_CATALOG).toEqual([
      { slotId: "slot-1", writerTemplateId: "cover_letter_writer_slot_1", reviewerTemplateId: "cover_letter_reviewer_slot_1" },
      { slotId: "slot-2", writerTemplateId: "cover_letter_writer_slot_2", reviewerTemplateId: "cover_letter_reviewer_slot_2" },
      { slotId: "slot-3", writerTemplateId: "cover_letter_writer_slot_3", reviewerTemplateId: "cover_letter_reviewer_slot_3" },
      { slotId: "slot-4", writerTemplateId: "cover_letter_writer_slot_4", reviewerTemplateId: "cover_letter_reviewer_slot_4" },
    ])
    expect(Object.isFrozen(SELECTED_JOB_BATCH_TEMPLATE_CATALOG)).toBe(true)
    expect(SELECTED_JOB_BATCH_TEMPLATE_CATALOG.every(Object.isFrozen)).toBe(true)
  })

  it("recognizes only exact existing slot spellings and slot IDs", () => {
    expect(selectedJobBatchTemplatesForSlot("slot-2")?.writerTemplateId).toBe("cover_letter_writer_slot_2")
    expect(selectedJobBatchTemplatesForSlot("slot-5")).toBeNull()
    for (const nearMatch of ["cover_letter_writer_slot_0", "cover_letter_writer_slot_5", "cover_letter_writer_slot_01",
      "cover_letter_reviewer_slot_5", "cover_letter_writer_slot_1_extra", "other_cover_letter_writer_slot_1"]) {
      expect(isSelectedJobBatchTemplateId(nearMatch)).toBe(false)
    }
    for (const entry of SELECTED_JOB_BATCH_TEMPLATE_CATALOG) {
      expect(isSelectedJobBatchTemplateId(entry.writerTemplateId)).toBe(true)
      expect(isSelectedJobBatchTemplateId(entry.reviewerTemplateId)).toBe(true)
    }
  })
})
