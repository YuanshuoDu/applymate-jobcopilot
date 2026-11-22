import { Type, type Static } from '@sinclair/typebox'

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
    kind: Type.Literal('selected_job_batch_preparation'),
    version: Type.Literal(1),
  }, { additionalProperties: false }),
], { $id: 'agent.turn-intent' })

export type TurnIntent = Static<typeof TurnIntentSchema>

export const OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT = Object.freeze({
  kind: 'objective_task_graph_execution',
  version: 1,
} as const)

export const SELECTED_JOB_BATCH_PREPARATION_INTENT = Object.freeze({
  kind: 'selected_job_batch_preparation',
  version: 1,
} as const)
