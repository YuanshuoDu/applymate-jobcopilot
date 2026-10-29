import { describe, expect, it } from "vitest"

import { childWaitPgCost, childWaitStoredCostMatchesReceipt } from "./child-resume-wait-cost.js"

describe("child resume wait PostgreSQL cost comparison", () => {
  it("rounds provider receipt costs to NUMERIC(12,8) precision", () => {
    expect(childWaitPgCost(0.123456789)).toBe(0.12345679)
    expect(childWaitPgCost(0.123456784)).toBe(0.12345678)
    expect(childWaitPgCost(9999.99999999)).toBe(9999.99999999)
  })

  it("rounds exact half places away from zero, including scientific notation", () => {
    expect(childWaitPgCost(0.000000005)).toBe(0.00000001)
    expect(childWaitPgCost(1.234567895e-4)).toBe(0.00012346)
    expect(childWaitPgCost(1e-9)).toBe(0)
  })

  it("rejects values that PostgreSQL NUMERIC(12,8) cannot persist", () => {
    expect(childWaitPgCost(9999.999999995)).toBeUndefined()
    expect(childWaitPgCost(10000)).toBeUndefined()
    expect(childWaitPgCost(-0.01)).toBeUndefined()
    expect(childWaitPgCost(Number.NaN)).toBeUndefined()
    expect(childWaitPgCost(Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  it("accepts only a canonical stored cost equal after PostgreSQL rounding", () => {
    expect(childWaitStoredCostMatchesReceipt(0.12345679, 0.123456789)).toBe(true)
    expect(childWaitStoredCostMatchesReceipt(0.12345678, 0.123456789)).toBe(false)
    expect(childWaitStoredCostMatchesReceipt(0.123456789, 0.123456789)).toBe(false)
    expect(childWaitStoredCostMatchesReceipt(0, 9999.999999995)).toBe(false)
  })
})
