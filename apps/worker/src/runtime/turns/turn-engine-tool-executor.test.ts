import { describe, expect, it } from "vitest"
import type { TurnEngineToolExecutor } from "./turn-engine-tool-executor.js"
import type { TurnEngineToolExecutor as PublicTurnEngineToolExecutor } from "./turn-engine-types.js"

describe("TurnEngineToolExecutor contract", () => {
  it("keeps server final-wait provenance outside the model-provided tool input", async () => {
    const observed: Parameters<TurnEngineToolExecutor>[0][] = []
    const executor: TurnEngineToolExecutor = async input => {
      observed.push(input)
      return { id: input.call.id, toolName: input.call.toolName, toolVersion: input.call.toolVersion, status: "completed", errorCode: null }
    }
    const compatibleExecutor: PublicTurnEngineToolExecutor = executor
    const toolInput = { taskIds: ["child-1"] }
    const input: Parameters<TurnEngineToolExecutor>[0] = {
      scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-2",
      signal: new AbortController().signal, remainingTurnSteps: 3,
      serverGeneratedFinalDependencyWait: { stepId: "step-1", toolCallId: "server-wait-call" },
      call: { id: "server-wait-call", toolName: "wait_subagents", toolVersion: "1", input: toolInput },
    }

    await compatibleExecutor(input)

    expect(observed).toEqual([input])
    expect(Object.hasOwn(toolInput, "serverGeneratedFinalDependencyWait")).toBe(false)
  })
})