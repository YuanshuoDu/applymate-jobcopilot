import { Type, type Static } from '@sinclair/typebox'
import { IdSchema } from './common.js'

export const OBJECTIVE_LOCATION_STEER_SCHEMA_VERSION = 'agent-harness.v2.objective-location-steer.v1' as const
export const OBJECTIVE_LOCATION_STEER_ACCEPTED_EVENT_TYPE = 'agent.objective.locations_accepted' as const

/** Produces the exact accepted user message bound to a normalized location list. */
export function formatObjectiveLocationSteerMessage(locations: readonly string[]): string {
  return `The user explicitly confirmed these allowed job locations: ${JSON.stringify(locations)}.`
}

const OBJECTIVE_LOCATION_STEER_MAX_LOCATIONS = 8
const OBJECTIVE_LOCATION_STEER_MAX_LOCATION_LENGTH = 128

const LocationInputSchema = Type.String({
  minLength: 1,
  maxLength: OBJECTIVE_LOCATION_STEER_MAX_LOCATION_LENGTH,
  pattern: '\\S',
})

/** Opt-in request shape. Raw location text is retained for server-side normalization. */
export const ObjectiveLocationSteerRequestSchema = Type.Object({
  schemaVersion: Type.Literal(OBJECTIVE_LOCATION_STEER_SCHEMA_VERSION),
  clientMessageId: IdSchema,
  expectedTurnId: IdSchema,
  expectedRevision: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
  locations: Type.Array(LocationInputSchema, { minItems: 1, maxItems: OBJECTIVE_LOCATION_STEER_MAX_LOCATIONS }),
}, { $id: 'agent.objective.locations-steer.request', additionalProperties: false })

/** Server-authored receipt shape; acceptance requires a separate binding to input.accepted. */
export const ObjectiveLocationSteerReceiptSchema = Type.Object({
  schemaVersion: Type.Literal(OBJECTIVE_LOCATION_STEER_SCHEMA_VERSION),
  acceptedInputSequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  locations: Type.Array(LocationInputSchema, { minItems: 1, maxItems: OBJECTIVE_LOCATION_STEER_MAX_LOCATIONS }),
}, { $id: 'agent.objective.locations-steer.receipt', additionalProperties: false })

export type ObjectiveLocationSteerRequest = Static<typeof ObjectiveLocationSteerRequestSchema>
export type ObjectiveLocationSteerReceipt = Static<typeof ObjectiveLocationSteerReceiptSchema>
