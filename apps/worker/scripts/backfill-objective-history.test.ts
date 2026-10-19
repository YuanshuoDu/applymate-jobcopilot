import { describe, expect, it } from "vitest"
import { parseBackfillScriptArguments } from "./backfill-objective-history.js"

describe("backfill-objective-history script arguments", () => {
  it("is inert unless the explicit execute flag is present", () => {
    expect(parseBackfillScriptArguments([])).toEqual({ execute: false, options: {} })
    expect(parseBackfillScriptArguments(["--execute"])).toEqual({ execute: true, options: {} })
  })

  it("accepts bounded batch controls without adding an automatic package entrypoint", () => {
    expect(parseBackfillScriptArguments(["--execute", "--batch-size", "100", "--max-batches", "5"])).toEqual({
      execute: true, options: { batchSize: 100, maxBatches: 5 },
    })
    expect(() => parseBackfillScriptArguments(["--batch-size", "0"])).toThrow("positive integer")
    expect(() => parseBackfillScriptArguments(["--unknown"])).toThrow("Unknown backfill argument")
  })
})
