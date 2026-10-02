import { describe, expect, it } from "vitest"

import type {
  PersistedToolCallRecovery,
  ToolCallRecovery,
  TurnEngineToolCall,
  TurnEngineToolResult,
} from "./turn-engine-tool-types.js"
import type {
  PersistedToolCallRecovery as CompatPersistedToolCallRecovery,
  ToolCallRecovery as CompatToolCallRecovery,
  TurnEngineToolCall as CompatTurnEngineToolCall,
  TurnEngineToolResult as CompatTurnEngineToolResult,
} from "./turn-engine-types.js"

const call: TurnEngineToolCall = {
  id: "call-1",
  name: "jobs.search",
  arguments: { query: "Berlin engineer" },
}
const result: TurnEngineToolResult = {
  id: call.id,
  toolName: call.name,
  toolVersion: "1",
  status: "completed",
  output: [{ title: "Software Engineer" }],
  errorCode: null,
}
const persisted: PersistedToolCallRecovery = {
  call,
  toolVersion: "1",
  stepId: "step-1",
  callItem: { id: "call-item-1", revision: 2 },
  resultItem: { id: "result-item-1", revision: 1 },
  durableResult: result,
}
const recovery: ToolCallRecovery = { ...persisted, action: "reconcile" }

const compatibleCall: CompatTurnEngineToolCall = call
const compatibleResult: CompatTurnEngineToolResult = result
const compatiblePersisted: CompatPersistedToolCallRecovery = persisted
const compatibleRecovery: CompatToolCallRecovery = recovery

describe("turn engine tool type exports", () => {
  it("keeps the new shapes usable and compatible through the existing type entrypoint", () => {
    expect({
      call: compatibleCall,
      result: compatibleResult,
      persisted: compatiblePersisted,
      recovery: compatibleRecovery,
    }).toEqual({
      call,
      result,
      persisted,
      recovery,
    })
  })
})