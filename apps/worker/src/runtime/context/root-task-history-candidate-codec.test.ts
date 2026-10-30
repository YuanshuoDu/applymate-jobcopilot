import { describe, expect, it } from "vitest"
import { parseRootTaskHistoryCandidate } from "./root-task-history-candidate-codec.js"

function outcome(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceTurnId: "source-turn", sourceRootTaskId: "source-root", terminalSequence: 8n,
    taskGraph: { revision: 1, nodes: [{ templateId: "scout", status: "failed" }] },
    ...overrides,
  }
}

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
})
