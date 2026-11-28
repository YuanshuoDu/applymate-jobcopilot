import { describe, expect, it } from "vitest"

import { rootOutputBudgetFailureText } from "./root-output-budget-failure.js"

describe("Root output-budget failure copy", () => {
  it.each([
    ["root_output_budget_configured_zero_limit", "configured output limit is zero", "配置的输出额度为零"],
    ["root_output_budget_settled_exhausted", "settled usage leaves no output allowance", "已结算用量已耗尽"],
    ["root_output_budget_active_reservation_hold", "holds the remaining allowance", "占用了剩余额度"],
  ] as const)("explains %s without suggesting an automatic replay", (code, english, chinese) => {
    expect(rootOutputBudgetFailureText(code, "en")).toContain(english)
    expect(rootOutputBudgetFailureText(code, "zh")).toContain(chinese)
    expect(rootOutputBudgetFailureText(code, "en")).toMatch(/not automatically replayed|No automatic retry/)
  })

  it("leaves unrecognized or unclassified failure reasons on the existing projection", () => {
    expect(rootOutputBudgetFailureText("output_budget_exhausted", "en")).toBeUndefined()
    expect(rootOutputBudgetFailureText("root_output_budget_future_state", "en")).toBeUndefined()
    expect(rootOutputBudgetFailureText({ code: "root_output_budget_active_reservation_hold" }, "en")).toBeUndefined()
  })
})
