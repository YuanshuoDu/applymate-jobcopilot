import { describe, expect, it } from "vitest"
import {
  parseRootTaskHistoryBranchReplacementEpisode,
  projectRootTaskHistoryBranchReplacementEpisode,
  ROOT_TASK_HISTORY_BRANCH_REPLACEMENT_EPISODE_SCHEMA_VERSION,
} from "./root-task-history-branch-replacement-history.js"

const witness = { reason: "result_invalid" as const, sourceTemplateIds: ["scout", "analyst"], successorTemplateIds: ["scout", "analyst"] }

describe("verified branch-replacement history episode", () => {
  it("projects only bounded role counts from a matched verified closure", () => {
    const episode = projectRootTaskHistoryBranchReplacementEpisode(witness)
    expect(episode).toEqual({
      schemaVersion: ROOT_TASK_HISTORY_BRANCH_REPLACEMENT_EPISODE_SCHEMA_VERSION,
      reason: "result_invalid", failedRole: "scout",
      replacedRoles: { scout: 1, analyst: 1, writer: 0, reviewer: 0, other: 0 },
      successorRoles: { scout: 1, analyst: 1, writer: 0, reviewer: 0, other: 0 },
    })
    expect(JSON.stringify(episode)).not.toMatch(/taskId|nodeKey|digest|goal|text|url/i)
  })

  it("rejects source and successor closures with different sizes or role counts", () => {
    expect(projectRootTaskHistoryBranchReplacementEpisode({ ...witness, successorTemplateIds: ["scout"] })).toBeNull()
    expect(projectRootTaskHistoryBranchReplacementEpisode({ ...witness, successorTemplateIds: ["scout", "scout"] })).toBeNull()
    expect(projectRootTaskHistoryBranchReplacementEpisode({ ...witness, sourceTemplateIds: ["analyst", "analyst"] })).toBeNull()
    expect(projectRootTaskHistoryBranchReplacementEpisode({ ...witness, reason: "result_ambiguous" as "result_invalid" })).toBeNull()
  })

  it("parses only the closed bounded schema and rechecks closure equivalence", () => {
    const episode = projectRootTaskHistoryBranchReplacementEpisode(witness)!
    expect(parseRootTaskHistoryBranchReplacementEpisode(episode)).toEqual(episode)
    expect(parseRootTaskHistoryBranchReplacementEpisode({ ...episode, privateId: "task-1" })).toBeNull()
    expect(parseRootTaskHistoryBranchReplacementEpisode({ ...episode, successorRoles: { ...episode.successorRoles, analyst: 0 } })).toBeNull()
    expect(parseRootTaskHistoryBranchReplacementEpisode({ ...episode, replacedRoles: { ...episode.replacedRoles, scout: 9 } })).toBeNull()
  })
})
