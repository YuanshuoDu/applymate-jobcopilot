import { Type } from '@sinclair/typebox'
import { schemaVersion } from './version.js'

export const SchemaVersionSchema = Type.Literal(schemaVersion)
export const IdSchema = Type.String({ minLength: 1, maxLength: 256 })
export const NonEmptyTextSchema = Type.String({ minLength: 1 })
export const TimestampSchema = Type.String({
  minLength: 20,
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
})
export const NullableIdSchema = Type.Union([IdSchema, Type.Null()])
export const SequenceSchema = Type.Integer({ minimum: 0 })

export const JsonValueSchema = Type.Unknown()

export const ActorSchema = Type.Union([
  Type.Literal('user'),
  Type.Literal('orchestrator'),
  Type.Literal('subagent'),
  Type.Literal('tool'),
  Type.Literal('system'),
])

export type Actor = 'user' | 'orchestrator' | 'subagent' | 'tool' | 'system'
