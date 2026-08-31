import Ajv, { type AnySchema, type ErrorObject, type ValidateFunction } from 'ajv'
import type { TSchema } from '@sinclair/typebox'

const ajv = new Ajv({ allErrors: true, strict: true })
const validatorCache = new Map<string, ValidateFunction<unknown>>()

export type ValidationIssue = Pick<ErrorObject, 'instancePath' | 'keyword' | 'message' | 'params'>

export function getValidator(schema: TSchema): ValidateFunction<unknown> {
  const schemaId = typeof schema.$id === 'string' ? schema.$id : JSON.stringify(schema)
  const cached = validatorCache.get(schemaId)
  if (cached) return cached
  const validator = ajv.compile(schema as AnySchema) as ValidateFunction<unknown>
  validatorCache.set(schemaId, validator)
  return validator
}

export function validate(schema: TSchema, value: unknown): boolean {
  return getValidator(schema)(value) === true
}

export function assertValid(schema: TSchema, value: unknown, label = 'protocol value'): void {
  const validator = getValidator(schema)
  if (validator(value)) return
  const issues: ValidationIssue[] = (validator.errors ?? []).map(({ instancePath, keyword, message, params }) => ({ instancePath, keyword, message, params }))
  throw new ProtocolValidationError(`${label} failed schema validation`, issues)
}

export function validatorCacheSize(): number {
  return validatorCache.size
}

export class ProtocolValidationError extends Error {
  constructor(message: string, public readonly issues: ValidationIssue[]) {
    super(message)
    this.name = 'ProtocolValidationError'
  }
}
