import { describe, expect, it } from "vitest"

import { parseRootOutputTokenBudget, RootOutputTokenBudgetConfigurationError } from "./root-output-token-budget.js"

describe("parseRootOutputTokenBudget", () => {
  it("preserves existing behavior when the optional setting is absent", () => {
    expect(parseRootOutputTokenBudget(undefined)).toEqual({})
  })

  it.each(["0", "64", "2147483647"])("accepts the valid ceiling %s", (value) => {
    expect(parseRootOutputTokenBudget(value)).toEqual({ limits: { maxOutputTokens: Number(value) } })
  })

  it.each(["", "-1", "+1", "1.5", "1e3", " 8", "8 ", "2147483648", "999999999999999999999"])(
    "fails closed for invalid configured value %j",
    (value) => expect(() => parseRootOutputTokenBudget(value)).toThrow(RootOutputTokenBudgetConfigurationError),
  )
})
