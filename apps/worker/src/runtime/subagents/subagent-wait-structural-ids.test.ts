import { describe, expect, it } from "vitest"
import { redactSensitiveText } from "@jobcopilot/shared"
import { markCanonicalSubagentWaitTargetIds, safeSubagentWaitJson } from "./subagent-wait-structural-ids.js"

const targetId = "subagent-00000000-0000-4000-8000-000000000000"

describe("canonical wait structural IDs", () => {
  it("preserves IDs only at validated wait target positions", () => {
    expect(redactSensitiveText(targetId)).not.toBe(targetId)
    const request = { targetTaskIds: [targetId] }
    const outcome = { taskIds: [targetId], matchedTaskIds: [targetId], tasks: [{ taskId: targetId, result: { finalText: targetId } }] }
    expect(markCanonicalSubagentWaitTargetIds(request, outcome, [targetId])).toBe(true)

    const safe = safeSubagentWaitJson({ request, outcome }) as { request: typeof request; outcome: typeof outcome }
    expect(safe.request.targetTaskIds).toEqual([targetId])
    expect(safe.outcome.taskIds).toEqual([targetId])
    expect(safe.outcome.matchedTaskIds).toEqual([targetId])
    expect(safe.outcome.tasks[0]?.taskId).toBe(targetId)
    expect(safe.outcome.tasks[0]?.result.finalText).toBe("subagent-[REDACTED_PHONE]")
  })

  it("does not mark a mismatched canonical shape or preserve arbitrary result prose", () => {
    const request = { targetTaskIds: [targetId] }
    const outcome = { taskIds: ["other-target"], matchedTaskIds: [], tasks: [{ taskId: targetId, result: { finalText: targetId } }] }
    expect(markCanonicalSubagentWaitTargetIds(request, outcome, [targetId])).toBe(false)

    const safe = safeSubagentWaitJson({ request, outcome, prose: targetId }) as {
      request: { targetTaskIds: string[] }; outcome: { tasks: Array<{ taskId: string; result: { finalText: string } }> }; prose: string
    }
    expect(safe.request.targetTaskIds).toEqual(["subagent-[REDACTED_PHONE]"])
    expect(safe.outcome.tasks[0]?.taskId).toBe("subagent-[REDACTED_PHONE]")
    expect(safe.outcome.tasks[0]?.result.finalText).toBe("subagent-[REDACTED_PHONE]")
    expect(safe.prose).toBe("subagent-[REDACTED_PHONE]")
  })
})
