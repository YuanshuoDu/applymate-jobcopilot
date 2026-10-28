import { describe, expect, it } from "vitest"
import { createScheduledMultiScoutPrefixPlan } from "./scheduled-multi-scout-prefix-pg.fixture.js"

describe("scheduled multi-Scout PG prefix fixture", () => {
  it.each([2, 4])("builds a nonempty %i-source prefix with a selected Analyst subset", scoutCount => {
    const jobIds = Array.from({ length: 8 }, (_, index) => `job-${index + 1}`)
    const scoutTaskIds = Array.from({ length: scoutCount }, (_, index) => `scout-task-${index + 1}`)
    const plan = createScheduledMultiScoutPrefixPlan({ scoutTaskIds, analystTaskId: "analyst-task", jobIds, selectedJobIds: ["job-2", "job-4"] })

    expect(plan).not.toBeNull()
    expect(plan?.scouts.map(source => source.source)).toEqual(["greenhouse", "lever", "workday", "smartrecruiters"].slice(0, scoutCount))
    expect(plan?.analystDependencyNodeKeys).toEqual(plan?.scouts.map(source => source.nodeKey))
    expect(plan?.scouts.flatMap(source => source.candidateJobIds).sort()).toEqual([...jobIds].sort())
    expect(plan?.analystJobIds).toEqual(["job-2", "job-4"])
    expect(plan?.candidateUnionJobIds).toEqual(jobIds)
    expect(plan?.analystJobIds).not.toEqual(plan?.candidateUnionJobIds)
  })

  it("rejects unsupported, empty, duplicate, or out-of-union fixture inputs", () => {
    const base = { scoutTaskIds: ["scout-a", "scout-b"], analystTaskId: "analyst", jobIds: ["job-a", "job-b"], selectedJobIds: ["job-a"] }
    for (const invalid of [
      { ...base, scoutTaskIds: ["scout-a"] },
      { ...base, scoutTaskIds: ["scout-a", "scout-b", "scout-c", "scout-d", "scout-e"] },
      { ...base, scoutTaskIds: ["scout-a", "scout-a"] },
      { ...base, scoutTaskIds: ["scout-a", "scout-b"], jobIds: ["job-a"] },
      { ...base, jobIds: [] },
      { ...base, selectedJobIds: [] },
      { ...base, selectedJobIds: ["outside-union"] },
    ]) expect(createScheduledMultiScoutPrefixPlan(invalid)).toBeNull()
  })
})
