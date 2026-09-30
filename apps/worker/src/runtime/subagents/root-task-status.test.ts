import { describe, expect, it } from "vitest"

import { rootTaskStatusFromTurnResult } from "./root-task-status.js"
import type { TurnEngineResult } from "../turns/turn-engine-types.js"

describe("root task status mapping", () => {
  it.each([
    ["completed", "completed"],
    ["interrupted", "interrupted"],
    ["waiting_for_user", "waiting_for_user"],
    ["waiting_for_approval", "waiting_for_user"],
    ["waiting_for_dependency", "waiting"],
    ["failed", "failed"],
  ] as const)("maps %s to %s", (status, expected) => {
    expect(rootTaskStatusFromTurnResult({ status } as TurnEngineResult)).toBe(expected)
  })
})
