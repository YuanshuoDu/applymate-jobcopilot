import type { TSchema } from "@sinclair/typebox"
import { getValidator, type ValidationIssue } from "@jobcopilot/agent-protocol"

export class ToolSchemaValidationError extends Error {
  readonly code = "schema_error" as const

  constructor(
    message: string,
    readonly issues: readonly ValidationIssue[],
  ) {
    super(message)
    this.name = "ToolSchemaValidationError"
  }
}

export class ToolSchemaValidator {
  private readonly validators = new Map<string, ReturnType<typeof getValidator>>()

  validate(schema: TSchema, value: unknown, label: string): void {
    const validator = this.get(schema)
    if (validator(value)) return
    const issues: ValidationIssue[] = (validator.errors ?? []).map(({ instancePath, keyword, message, params }) => ({
      instancePath,
      keyword,
      message,
      params,
    }))
    throw new ToolSchemaValidationError(`${label} failed schema validation`, issues)
  }

  get size(): number {
    return this.validators.size
  }

  private get(schema: TSchema): ReturnType<typeof getValidator> {
    const key = typeof schema.$id === "string" ? schema.$id : JSON.stringify(schema)
    const cached = this.validators.get(key)
    if (cached) return cached
    const validator = getValidator(schema)
    this.validators.set(key, validator)
    return validator
  }
}
