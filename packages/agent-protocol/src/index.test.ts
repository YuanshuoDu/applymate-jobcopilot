import { describe, expect, it } from 'vitest'
import {
  AGENT_HARNESS_PROTOCOL_VERSION,
  AgentSessionControlCommandSchema,
  AgentSessionSchema,
  AgentTurnSchema,
  OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT,
  SELECTED_JOB_BATCH_PREPARATION_INTENT,
  SELECTED_JOB_BATCH_SLOT_IDS,
  SELECTED_JOB_BATCH_TEMPLATE_CATALOG,
  SessionControlEventPayloadSchema,
  TurnIntentSchema,
  VERIFIED_SHORTLIST_SELECTION_SCHEMA,
  parseVerifiedShortlistSelectionBinding,
  isSelectedJobBatchTemplateId,
  selectedJobBatchTemplatesForSlot,
  sameVerifiedShortlistSelectionBinding,
  schemaVersion,
  validate,
} from './index.js'

describe('public protocol export surface', () => {
  it('exposes schema and derived runtime validation from the package root', () => {
    expect(AGENT_HARNESS_PROTOCOL_VERSION).toBe('agent-harness.v2')
    expect(schemaVersion).toBe('agent-harness.v2')
    expect(validate(AgentSessionSchema, {})).toBe(false)
    expect(AgentTurnSchema.$id).toBe('agent.turn')
    expect(AgentSessionControlCommandSchema.$id).toBe('agent.session.control.command')
    expect(SessionControlEventPayloadSchema.$id).toBe('agent.session.control.event-payload')
    expect(TurnIntentSchema.$id).toBe('agent.turn-intent')
    expect(validate(TurnIntentSchema, OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT)).toBe(true)
    expect(validate(TurnIntentSchema, SELECTED_JOB_BATCH_PREPARATION_INTENT)).toBe(true)
    expect(VERIFIED_SHORTLIST_SELECTION_SCHEMA).toBe('agent-harness.v2.verified-shortlist-selection.v1')
    expect(SELECTED_JOB_BATCH_SLOT_IDS).toEqual(['slot-1', 'slot-2', 'slot-3', 'slot-4'])
    expect(selectedJobBatchTemplatesForSlot('slot-1')).toEqual(SELECTED_JOB_BATCH_TEMPLATE_CATALOG[0])
    expect(isSelectedJobBatchTemplateId('cover_letter_writer_slot_4')).toBe(true)
    expect(isSelectedJobBatchTemplateId('cover_letter_writer_slot_5')).toBe(false)
    const binding = parseVerifiedShortlistSelectionBinding({
      schemaVersion: VERIFIED_SHORTLIST_SELECTION_SCHEMA,
      source: { sessionId: 'session-1', sourceTurnId: 'turn-1', rootTaskId: 'root-1', graphItemId: 'task-graph:root-1', graphRevision: 1 },
      selectedJobIds: ['job-1', 'job-2'],
    })
    expect(binding).not.toBeNull()
    expect(sameVerifiedShortlistSelectionBinding(binding, binding)).toBe(true)
  })
})
