import { Type } from "@sinclair/typebox"
import { describe, expect, it } from "vitest"

import { ToolSchemaValidationError, ToolSchemaValidator } from "./schema-validator.js"

describe("ToolSchemaValidator", () => {
  it("caches compiled validators and reports structured schema issues", () => {
    const validator = new ToolSchemaValidator()
    const schema = Type.Object({ query: Type.String({ minLength: 2 }) }, { additionalProperties: false })

    expect(() => validator.validate(schema, { query: "" }, "input")).toThrow(ToolSchemaValidationError)
    expect(validator.size).toBe(1)
    expect(() => validator.validate(schema, { query: "ok" }, "input")).not.toThrow()
    expect(validator.size).toBe(1)
  })
})
