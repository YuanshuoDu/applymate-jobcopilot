import { Type, type Static } from '@sinclair/typebox'
import { IdSchema, SchemaVersionSchema } from './common.js'

export const AgentSessionControlActionSchema = Type.Union([Type.Literal('pause'), Type.Literal('resume')])

export const AgentSessionControlCommandSchema = Type.Object({
  schemaVersion: SchemaVersionSchema,
  clientMessageId: IdSchema,
  sessionId: IdSchema,
  action: AgentSessionControlActionSchema,
  expectedTurnId: IdSchema,
  expectedRevision: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
}, { $id: 'agent.session.control.command', additionalProperties: false })

export type AgentSessionControlAction = Static<typeof AgentSessionControlActionSchema>
export type AgentSessionControlCommand = Static<typeof AgentSessionControlCommandSchema>
