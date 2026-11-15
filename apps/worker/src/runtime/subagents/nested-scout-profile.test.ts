import { describe, expect, it } from "vitest"

import {
  NESTED_SCOUT_ALLOWED_SOURCES,
  NESTED_SCOUT_PROFILE_MARKER,
  nestedScoutProfileForTask,
} from "./nested-scout-profile.js"

function task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: "scout",
    taskType: "job_discovery",
    depth: 1,
    parentTaskId: "root-task",
    rootTaskId: "root-task",
    context: { nestedScoutProfile: NESTED_SCOUT_PROFILE_MARKER, targetRoles: ["Engineer"] },
    ...overrides,
  }
}

describe("nested Scout profile", () => {
  it("grants the frozen allowlisted source slice only to a marked direct-child discovery task", () => {
    const profile = nestedScoutProfileForTask(task())

    expect(profile).toEqual({ sourceSlice: ["greenhouse", "lever", "workday", "smartrecruiters", "personio"] })
    expect(profile?.sourceSlice).toBe(NESTED_SCOUT_ALLOWED_SOURCES)
    expect(Object.isFrozen(NESTED_SCOUT_ALLOWED_SOURCES)).toBe(true)
    expect(Object.isFrozen(profile)).toBe(true)
    expect(NESTED_SCOUT_ALLOWED_SOURCES).not.toContain("*")
  })

  it.each([
    ["missing marker", { context: { targetRoles: ["Engineer"] } }],
    ["wrong marker", { context: { nestedScoutProfile: "nested-scout-profile:v1" } }],
    ["marker with extra value", { context: { nestedScoutProfile: { value: NESTED_SCOUT_PROFILE_MARKER } } }],
    ["wrong role", { role: "analyst" }],
    ["wrong task type", { taskType: "research" }],
    ["root task depth", { depth: 0 }],
    ["grandchild depth", { depth: 2 }],
    ["string depth", { depth: "1" }],
    ["different parent", { parentTaskId: "another-parent" }],
    ["missing parent", { parentTaskId: null }],
    ["empty lineage", { parentTaskId: "", rootTaskId: "" }],
  ] as const)("denies %s", (_label, overrides) => {
    expect(nestedScoutProfileForTask(task(overrides))).toBeNull()
  })

  it.each([
    "selectedJobPreparation",
    "applicationFillPreparation",
    "coverLetterBase",
    "coverLetterBaseContext",
    "writerReviewFeedback",
    "writerReviewRevision",
    "scheduledAutomationCriteria",
  ] as const)("denies context containing the %s marker", marker => {
    const context = { nestedScoutProfile: NESTED_SCOUT_PROFILE_MARKER, [marker]: undefined }
    expect(nestedScoutProfileForTask(task({ context }))).toBeNull()
  })

  it.each([
    ["null context", null],
    ["array context", []],
    ["string context", "nested-scout-profile"],
    ["inherited marker", Object.create({ nestedScoutProfile: NESTED_SCOUT_PROFILE_MARKER })],
    ["accessor marker", Object.defineProperty({}, "nestedScoutProfile", { enumerable: true, get: () => NESTED_SCOUT_PROFILE_MARKER })],
    ["symbol key", { nestedScoutProfile: NESTED_SCOUT_PROFILE_MARKER, [Symbol("extra")]: true }],
  ] as const)("fails closed for malformed %s", (_label, context) => {
    expect(nestedScoutProfileForTask(task({ context }))).toBeNull()
  })

  it.each([null, [], "task", 42])("fails closed for malformed task %s", malformed => {
    expect(nestedScoutProfileForTask(malformed)).toBeNull()
  })
})
