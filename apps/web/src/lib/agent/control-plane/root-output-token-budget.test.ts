import { describe, expect, it } from "vitest"

import {
  readRootOutputTokenBudgetSnapshot,
  requirePersistedRootBudgetSnapshot,
  RootBudgetSnapshotInvalidError,
  ROOT_OUTPUT_TOKEN_BUDGET_ENV,
} from "./root-output-token-budget"

describe("Root output token budget configuration", () => {
  it("reads only the server environment setting", () => {
    const previous = process.env[ROOT_OUTPUT_TOKEN_BUDGET_ENV]
    process.env[ROOT_OUTPUT_TOKEN_BUDGET_ENV] = "96"
    try {
      expect(readRootOutputTokenBudgetSnapshot()).toEqual({ limits: { maxOutputTokens: 96 } })
    } finally {
      if (previous === undefined) delete process.env[ROOT_OUTPUT_TOKEN_BUDGET_ENV]
      else process.env[ROOT_OUTPUT_TOKEN_BUDGET_ENV] = previous
    }
  })

  it("preserves a retry snapshot as a JSON object and rejects malformed persisted snapshots", () => {
    const snapshot = { limits: { maxOutputTokens: 32, maxSteps: 9 }, policy: { marker: "persisted" } }
    expect(requirePersistedRootBudgetSnapshot(snapshot)).toBe(snapshot)
    expect(() => requirePersistedRootBudgetSnapshot(null)).toThrow(RootBudgetSnapshotInvalidError)
    expect(() => requirePersistedRootBudgetSnapshot([])).toThrow(RootBudgetSnapshotInvalidError)
  })
})
