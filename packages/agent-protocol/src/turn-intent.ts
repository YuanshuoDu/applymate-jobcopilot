import { Type, type Static } from '@sinclair/typebox'
import { IdSchema } from './common.js'
import { OBJECTIVE_APPLICATION_REVIEW_INTENT_SCHEMA } from './objective-application-review-intent.js'

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
  Type.Object({
    kind: Type.Literal('objective_application_review'),
    version: Type.Literal(1),
    selection: Type.Object({
      schema: Type.Literal(OBJECTIVE_APPLICATION_REVIEW_INTENT_SCHEMA),
      sourceTurnId: IdSchema,
      rootTaskId: IdSchema,
      graphItemId: IdSchema,
      graphRevision: Type.Integer({ minimum: 1 }),
      slotOrdinals: Type.Readonly(Type.Array(Type.Integer({ minimum: 1, maximum: 8 }), { minItems: 1, maxItems: 8 })),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal('selected_job_batch_preparation'),
    version: Type.Literal(1),
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

export const OBJECTIVE_APPLICATION_REVIEW_TURN_INTENT = Object.freeze({
  kind: 'objective_application_review',
  version: 1,
} as const)

export const SELECTED_JOB_BATCH_PREPARATION_INTENT = Object.freeze({
  kind: 'selected_job_batch_preparation',
  version: 1,
} as const)
