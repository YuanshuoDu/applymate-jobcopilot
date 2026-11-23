import { describe, expect, it } from 'vitest'
import { SELECTED_JOB_BATCH_PREPARATION_INTENT, VERIFIED_SHORTLIST_SELECTION_SCHEMA } from '@jobcopilot/agent-protocol'

import { parseSelectedJobBatchTurnIdentity, projectSelectedJobId } from './selected-job-batch-turn-identity'

const goal = 'Prepare draft materials for the selected Jobs from the verified shortlist. Do not submit applications.'
const binding = {
  schemaVersion: VERIFIED_SHORTLIST_SELECTION_SCHEMA,
  source: { sessionId: 'session_1', sourceTurnId: 'source_1', rootTaskId: 'root_1', graphItemId: 'graph_1', graphRevision: 3 },
  selectedJobIds: ['job_1', 'job_2'],
}
const input = {
  clientMessageId: 'message_1', goal, content: [{ type: 'text', text: goal }],
  intent: SELECTED_JOB_BATCH_PREPARATION_INTENT, verifiedShortlistSelection: binding,
}

describe('selected Job batch Turn identity', () => {
  it('parses the closed persisted input and its shortlist binding', () => {
    expect(parseSelectedJobBatchTurnIdentity(input)).toEqual(binding)
    expect(parseSelectedJobBatchTurnIdentity(JSON.stringify(input))).toEqual(binding)
  })

  it('rejects changed, malformed, or extended input and binding shapes', () => {
    const invalid = [
      { ...input, extra: true },
      { ...input, clientMessageId: '' },
      { ...input, goal: 'a different goal' },
      { ...input, content: [{ type: 'text', text: goal }, { type: 'text', text: 'extra' }] },
      { ...input, intent: { ...input.intent, extra: true } },
      { ...input, intent: { kind: input.intent.kind, version: 2 } },
      { ...input, verifiedShortlistSelection: { ...binding, extra: true } },
      { ...input, verifiedShortlistSelection: { ...binding, selectedJobIds: ['job_1', 'job_1'] } },
    ]
    for (const value of invalid) expect(parseSelectedJobBatchTurnIdentity(value)).toBeNull()
    expect(parseSelectedJobBatchTurnIdentity('{bad json')).toBeNull()
  })

  it('preserves the existing single-Job marker projection', () => {
    expect(projectSelectedJobId({ jobId: 'job_1' })).toBe('job_1')
    expect(projectSelectedJobId({ jobId: 'job_1', extra: true })).toBeNull()
  })
})
