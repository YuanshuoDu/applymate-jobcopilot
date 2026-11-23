import { describe, expect, it } from "vitest"
import { parseRootTaskHistoryCandidate } from "./root-task-history-candidate-codec.js"

function outcome(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceTurnId: "source-turn", sourceRootTaskId: "source-root", terminalSequence: 8n,
    taskGraph: { revision: 1, nodes: [{ templateId: "scout", status: "failed" }] },
    ...overrides,
  }
}
const replacementEpisode = { schemaVersion: "agent-harness.v2.root-task-history-branch-replacement-episode.v1",
  reason: "result_invalid", failedRole: "scout",
  replacedRoles: { scout: 1, analyst: 1, writer: 0, reviewer: 0, other: 0 },
  successorRoles: { scout: 1, analyst: 1, writer: 0, reviewer: 0, other: 0 } } as const

describe("root task history candidate codec", () => {
  it("requires canonical terminal witness identity for cross-session candidates", () => {
    const valid = outcome({ sourceSessionDiffers: true, terminalXid8: "10", terminalWitnessEventId: "marker-event" })
    expect(parseRootTaskHistoryCandidate(valid, true)).toMatchObject({
      sourceSessionDiffers: true, terminalXid8: 10n, terminalWitnessEventId: "marker-event",
    })
    for (const xid8 of ["0", "010", "+10", "18446744073709551616", " 10"]) {
      expect(parseRootTaskHistoryCandidate({ ...valid, terminalXid8: xid8 }, true)).toBeNull()
    }
    expect(parseRootTaskHistoryCandidate({ ...valid, terminalWitnessEventId: "" }, true)).toBeNull()
    const { terminalXid8: _xid, ...withoutXid } = valid
    expect(parseRootTaskHistoryCandidate(withoutXid, true)).toBeNull()
  })

  it("rejects timestamp-only chronology and preserves the same-session path without witnesses", () => {
    const local = outcome({ sourceSessionDiffers: false })
    expect(parseRootTaskHistoryCandidate(local, false)?.sourceSessionDiffers).toBe(false)
    expect(parseRootTaskHistoryCandidate({ ...local, terminalAt: new Date() }, false)).toBeNull()
  })

  it("keeps a valid same-session episode, drops malformed optional episodes, and omits foreign episodes", () => {
    const local = parseRootTaskHistoryCandidate(outcome({ sourceSessionDiffers: false, branchReplacementEpisode: replacementEpisode }), false)
    expect(local?.branchReplacementEpisode).toEqual(replacementEpisode)
    const malformed = parseRootTaskHistoryCandidate(outcome({ branchReplacementEpisode: { ...replacementEpisode, failedRole: "writer" } }), false)
    expect(malformed).toMatchObject({ sourceTurnId: "source-turn", safeNodes: [{ projection: { taskKind: "scout", status: "failed" } }] })
    expect(malformed?.branchReplacementEpisode).toBeUndefined()
    const hidden = outcome({ sourceSessionDiffers: false })
    Object.defineProperty(hidden, "branchReplacementEpisode", { value: replacementEpisode, enumerable: false })
    expect(parseRootTaskHistoryCandidate(hidden, false)?.branchReplacementEpisode).toBeUndefined()
    const foreign = parseRootTaskHistoryCandidate(outcome({ sourceSessionDiffers: true, terminalXid8: "10",
      terminalWitnessEventId: "witness", branchReplacementEpisode: replacementEpisode }), true)
    expect(foreign?.sourceSessionDiffers).toBe(true)
    expect(foreign?.branchReplacementEpisode).toBeUndefined()
    expect(parseRootTaskHistoryCandidate(outcome({ branchReplacementEpisode: replacementEpisode }), true)?.branchReplacementEpisode).toBeUndefined()
  })
})
