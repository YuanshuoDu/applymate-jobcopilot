import { Type, type Static } from '@sinclair/typebox'
import { IdSchema } from './common.js'

export const TurnIntentSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('interactive_discovery_shortlist'),
    version: Type.Literal(1),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal('objective_task_graph_execution'),
    version: Type.Literal(1),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal('reviewed_application_review'),
    version: Type.Literal(1),
    sourceTurnId: IdSchema,
    jobId: IdSchema,
  }, { additionalProperties: false }),
], { $id: 'agent.turn-intent' })

export type TurnIntent = Static<typeof TurnIntentSchema>

export const OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT = Object.freeze({
  kind: 'objective_task_graph_execution',
  version: 1,
} as const)

export const REVIEWED_APPLICATION_REVIEW_INTENT = Object.freeze({
  kind: 'reviewed_application_review',
  version: 1,
} as const)
