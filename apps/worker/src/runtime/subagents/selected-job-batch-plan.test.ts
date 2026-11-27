import { describe, expect, it } from "vitest"
import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import { SELECTED_JOB_BATCH_SLOT_IDS as PROTOCOL_SLOT_IDS } from "@jobcopilot/agent-protocol"
import { taskGraphTemplatesForSelectedJob } from "./task-graph-templates.js"
import {
  createSelectedJobBatchTemplateRegistry,
  pairSelectedJobBatchCorrectionProposal,
  pairSelectedJobBatchPlan,
  selectedJobBatchSlotsFromTemplates,
  SelectedJobBatchPlanError,
  SELECTED_JOB_BATCH_SLOT_IDS,
  type SelectedJobBatchSlot,
} from "./selected-job-batch-plan.js"
import type { TaskGraphTaskTemplate } from "./task-graph-command-port.js"

const slots: readonly SelectedJobBatchSlot[] = [
  { slotId: "slot-1", jobId: "job-a" },
  { slotId: "slot-2", jobId: "job-b" },
]
const single = taskGraphTemplatesForSelectedJob({ jobId: "prototype-job" })
const prototypes = { writer: single.cover_letter_writer!, reviewer: single.cover_letter_reviewer! }
const node = (key: string, templateId: string, dependsOn: string[] = []) => ({ key, templateId, dependsOn })
const twoPairPlan = [
  node("writer-a", "cover_letter_writer_slot_1"),
  node("reviewer-a", "cover_letter_reviewer_slot_1", ["writer-a"]),
  node("writer-b", "cover_letter_writer_slot_2"),
  node("reviewer-b", "cover_letter_reviewer_slot_2", ["writer-b"]),
]

describe("selected Job batch plan", () => {
  it("reexports the shared finite slot catalog for existing Worker callers", () => {
    expect(SELECTED_JOB_BATCH_SLOT_IDS).toBe(PROTOCOL_SLOT_IDS)
  })

  it("builds finite slot templates from the existing Writer and Reviewer contracts", () => {
    const registry = createSelectedJobBatchTemplateRegistry(slots, prototypes)

    expect(Object.keys(registry.templates)).toEqual([
      "cover_letter_writer_slot_1", "cover_letter_reviewer_slot_1",
      "cover_letter_writer_slot_2", "cover_letter_reviewer_slot_2",
    ])
    expect(registry.templates.cover_letter_writer_slot_1).toMatchObject({
      role: "writer", taskType: single.cover_letter_writer?.taskType,
      allowedActions: single.cover_letter_writer?.allowedActions,
      context: { selectedJobPreparation: { jobId: "job-a" } },
    })
    expect(registry.templates.cover_letter_reviewer_slot_2).toMatchObject({
      role: "reviewer", taskType: single.cover_letter_reviewer?.taskType,
      allowedActions: single.cover_letter_reviewer?.allowedActions,
      context: { selectedJobPreparation: { jobId: "job-b" } },
    })
    expect(Object.keys(registry.templates).join(" ")).not.toContain("job-a")
    expect(Object.keys(registry.templates).join(" ")).not.toContain("job-b")
    expect(selectedJobBatchSlotsFromTemplates(registry.templates)).toEqual(slots)
    expect(selectedJobBatchSlotsFromTemplates({ ...registry.templates, extra: prototypes.writer })).toBeNull()
    expect(selectedJobBatchSlotsFromTemplates({ ...registry.templates,
      cover_letter_reviewer_slot_2: { ...registry.templates.cover_letter_reviewer_slot_2, taskType: "writer" } })).toBeNull()
    expect(selectedJobBatchSlotsFromTemplates({ ...registry.templates,
      cover_letter_reviewer_slot_2: { ...registry.templates.cover_letter_reviewer_slot_2,
        context: { selectedJobPreparation: { jobId: "job-a" } } } })).toBeNull()
    expect(selectedJobBatchSlotsFromTemplates({ ...registry.templates,
      cover_letter_writer_slot_1: { ...registry.templates.cover_letter_writer_slot_1,
        allowedActions: [...registry.templates.cover_letter_writer_slot_1.allowedActions, "jobs.search"] } })).toBeNull()
  })

  it("pairs each dependency-free Writer with only its own Reviewer", () => {
    const pairs = pairSelectedJobBatchPlan(twoPairPlan, slots)

    expect(pairs).toEqual([
      { slotId: "slot-1", jobId: "job-a", writerTemplateId: "cover_letter_writer_slot_1", writerNodeKey: "writer-a",
        reviewerTemplateId: "cover_letter_reviewer_slot_1", reviewerNodeKey: "reviewer-a" },
      { slotId: "slot-2", jobId: "job-b", writerTemplateId: "cover_letter_writer_slot_2", writerNodeKey: "writer-b",
        reviewerTemplateId: "cover_letter_reviewer_slot_2", reviewerNodeKey: "reviewer-b" },
    ])
  })

  it("keeps initial admission revision-zero only and validates correction proposal shape separately", () => {
    const correction = [
      node("writer-a-v2", "cover_letter_writer_slot_1", ["reviewer-a"]),
      node("reviewer-a-v2", "cover_letter_reviewer_slot_1", ["writer-a-v2"]),
    ]
    expect(() => pairSelectedJobBatchPlan([...twoPairPlan, ...correction], slots)).toThrowError(SelectedJobBatchPlanError)
    expect(pairSelectedJobBatchCorrectionProposal(correction, slots)).toEqual([
      { slotId: "slot-1", writerNodeKey: "writer-a-v2", reviewerNodeKey: "reviewer-a-v2", previousReviewerNodeKey: "reviewer-a" },
    ])
    expect(pairSelectedJobBatchCorrectionProposal([
      node("writer-a-v2", "cover_letter_writer_slot_1", ["reviewer-b"]),
      node("reviewer-a-v2", "cover_letter_reviewer_slot_1", ["writer-a-v2"]),
    ], slots)[0]?.previousReviewerNodeKey).toBe("reviewer-b")
  })

  it.each([
    ["cross-linked reviewers", [node("writer-a", "cover_letter_writer_slot_1"), node("reviewer-a", "cover_letter_reviewer_slot_1", ["writer-b"]),
      node("writer-b", "cover_letter_writer_slot_2"), node("reviewer-b", "cover_letter_reviewer_slot_2", ["writer-a"])]],
    ["a dependent Writer", [node("writer-a", "cover_letter_writer_slot_1", ["writer-b"]), node("reviewer-a", "cover_letter_reviewer_slot_1", ["writer-a"]),
      node("writer-b", "cover_letter_writer_slot_2"), node("reviewer-b", "cover_letter_reviewer_slot_2", ["writer-b"])]],
    ["a missing pair member", twoPairPlan.slice(0, 3)],
    ["an extra node", [...twoPairPlan, node("extra", "cover_letter_writer_slot_3")]],
    ["an unknown template", [...twoPairPlan.slice(0, 3), node("unknown", "reviewer")]],
    ["an out-of-range template", [...twoPairPlan.slice(0, 3), node("unknown", "cover_letter_reviewer_slot_5")]],
    ["a malformed node", [...twoPairPlan.slice(0, 3), { key: "missing-deps", templateId: "cover_letter_reviewer_slot_2" }]],
  ] as const)("rejects %s before graph materialization", (_case, plan) => {
    expect(() => pairSelectedJobBatchPlan(plan, slots)).toThrowError(SelectedJobBatchPlanError)
  })

  it.each([
    ["duplicate slot", [{ slotId: "slot-1", jobId: "job-a" }, { slotId: "slot-1", jobId: "job-b" }]],
    ["unknown slot", [{ slotId: "slot-1", jobId: "job-a" }, { slotId: "slot-5", jobId: "job-b" }]],
    ["duplicate Job", [{ slotId: "slot-1", jobId: "job-a" }, { slotId: "slot-2", jobId: "job-a" }]],
    ["malformed slot", [{ slotId: "slot-1", jobId: "job-a", callerScope: "ignored" }, { slotId: "slot-2", jobId: "job-b" }]],
    ["single Job selection", [{ slotId: "slot-1", jobId: "job-a" }]],
  ] as const)("rejects %s", (_case, selection) => {
    expect(() => createSelectedJobBatchTemplateRegistry(selection, prototypes)).toThrowError(SelectedJobBatchPlanError)
  })

  it("uses all capacity available under the existing eight-node TaskGraph ceiling", () => {
    const fourSlots: readonly SelectedJobBatchSlot[] = [
      ...slots,
      { slotId: "slot-3", jobId: "job-c" },
      { slotId: "slot-4", jobId: "job-d" },
    ]
    const registry = createSelectedJobBatchTemplateRegistry(fourSlots, prototypes)

    expect(Object.keys(registry.templates)).toHaveLength(TASK_GRAPH_LIMITS.maxNodes)
    expect(registry.templates).toHaveProperty("cover_letter_reviewer_slot_4")
    expect(() => createSelectedJobBatchTemplateRegistry([
      ...fourSlots, { slotId: "slot-5", jobId: "job-e" },
    ], prototypes)).toThrowError(SelectedJobBatchPlanError)
  })

  it("rejects prototype roles outside the registered Writer/Reviewer contracts", () => {
    expect(() => createSelectedJobBatchTemplateRegistry(slots, {
      writer: prototypes.reviewer, reviewer: prototypes.reviewer,
    } as { writer: TaskGraphTaskTemplate; reviewer: TaskGraphTaskTemplate })).toThrowError(SelectedJobBatchPlanError)
  })
})
