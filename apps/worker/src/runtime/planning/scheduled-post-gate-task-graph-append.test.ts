import { describe, expect, it } from "vitest"

import {
  hasScheduledTaskGraphPackageRefsShape,
  parseScheduledTaskGraphPackageRefs,
  parseTaskGraphProposalRepairOf,
  taskGraphProposalTextArray,
} from "./scheduled-post-gate-task-graph-append.js"

function exactRecord(value: unknown, keys: string): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Object.keys(value).sort().join(",") === keys
}

describe("scheduled post-Gate TaskGraph proposal helpers", () => {
  it("accepts packageRefs only on exact scheduled Execute node shapes", () => {
    const execute = { key: "execute-1", templateId: "scheduled.application.execute", goal: "Prepare approved jobs",
      successCriteria: ["Each job is prepared"], dependsOn: ["gate"], packageRefs: ["job-1", "job-2"] }
    expect(hasScheduledTaskGraphPackageRefsShape(execute, exactRecord)).toBe(true)
    expect(parseScheduledTaskGraphPackageRefs(execute, 50, taskGraphProposalTextArray)).toEqual({
      valid: true, packageRefs: ["job-1", "job-2"],
    })
    expect(parseScheduledTaskGraphPackageRefs({ ...execute, templateId: "scout" }, 50, taskGraphProposalTextArray))
      .toEqual({ valid: false })
    expect(parseScheduledTaskGraphPackageRefs({ ...execute, packageRefs: ["job-1", "job-1"] }, 50, taskGraphProposalTextArray))
      .toEqual({ valid: false })
    expect(parseScheduledTaskGraphPackageRefs({ ...execute, packageRefs: [" job-1"] }, 50, taskGraphProposalTextArray))
      .toEqual({ valid: false })
    expect(parseScheduledTaskGraphPackageRefs({ ...execute, packageRefs: new Array<string>(1) }, 50, taskGraphProposalTextArray))
      .toEqual({ valid: false })
    expect(parseScheduledTaskGraphPackageRefs({ ...execute, packageRefs: Array.from({ length: 51 }, (_, index) => `job-${index}`) }, 50,
      taskGraphProposalTextArray)).toEqual({ valid: false })
    expect(parseScheduledTaskGraphPackageRefs({ key: "scout", templateId: "scout" }, 50, taskGraphProposalTextArray))
      .toEqual({ valid: true })
  })

  it("preserves bounded repair relation parsing while sharing the array validator", () => {
    const repair = { graphRootTaskId: "root-1", nodeKey: "analyst", taskId: "task-analyst", criterionIds: ["evidence"] }
    expect(parseTaskGraphProposalRepairOf(repair, 2, {
      plainRecord: exactRecord,
      text: (value: unknown, maximum: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= maximum,
      textArray: taskGraphProposalTextArray,
      maxKeyLength: 128,
      maxCriteria: 8,
    })).toEqual(repair)
    expect(taskGraphProposalTextArray(["one", "two"], false, 2, 8)).toBe(true)
    expect(taskGraphProposalTextArray(["one", "one"], false, 2, 8)).toBe(true)
    expect(taskGraphProposalTextArray([""], false, 2, 8)).toBe(false)
  })
})
