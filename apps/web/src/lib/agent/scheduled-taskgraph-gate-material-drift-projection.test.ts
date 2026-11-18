import { describe, expect, it } from 'vitest'
import {
  scheduledMaterialDriftGateTaskId,
  scheduledMaterialDriftRecoveryReason,
  SCHEDULED_PREPARE_MATERIAL_DRIFT_RECOVERY_REASON,
  type ScheduledMaterialDriftProjectionFacts,
} from './scheduled-taskgraph-gate-material-drift-projection'

const owner = {
  userId: 'user_1', sessionId: 'session_1', turnId: 'turn_1', rootTaskId: 'root_1', rootAttemptCount: 3,
  turnLeaseOwnerId: 'historical_turn_lease', turnLeaseVersion: 4, executionId: 'execution_1', executionAttemptCount: 5,
}
const gateOwner = { taskId: 'gate_1', leaseOwnerId: 'historical_gate_lease', attemptCount: 2 }
const marker = {
  schemaVersion: 'agent-harness.v2.scheduled-prepare-material-drift-terminal.v1',
  reason: SCHEDULED_PREPARE_MATERIAL_DRIFT_RECOVERY_REASON,
  owner, gate: gateOwner,
  analyzeFingerprintDigest: digest('a'), prepareProofDigest: digest('b'), artifactDigest: digest('c'),
  currentMaterialDigest: digest('d'), proofDigest: digest('e'),
}

function digest(char: string) { return `sha256:${char.repeat(64)}` }
function facts(overrides: Partial<ScheduledMaterialDriftProjectionFacts> = {}): ScheduledMaterialDriftProjectionFacts {
  return {
    userId: 'user_1', sessionId: 'session_1', activeTurnId: 'turn_1', newestTurnId: 'turn_1',
    turn: { id: 'turn_1', userId: 'user_1', sessionId: 'session_1', status: 'waiting_for_dependency',
      source: 'automation', executionMode: 'canonical_task_graph', rootTaskId: 'root_1',
      input: { automationRunMode: 'scheduled' }, leaseVersion: 4 },
    root: { id: 'root_1', sessionId: 'session_1', turnId: 'turn_1', rootTaskId: 'root_1', parentTaskId: null,
      depth: 0, role: 'orchestrator', taskType: 'root', status: 'waiting', attemptCount: 3 },
    gate: { id: 'gate_1', sessionId: 'session_1', turnId: 'turn_1', rootTaskId: 'root_1', parentTaskId: 'root_1',
      depth: 1, role: 'prepare', taskType: 'scheduled_taskgraph_gate', status: 'failed', attemptCount: 2 },
    execution: { id: 'execution_1', userId: 'user_1', sessionId: 'session_1', status: 'failed',
      error: SCHEDULED_PREPARE_MATERIAL_DRIFT_RECOVERY_REASON, attemptCount: 5,
      state: { scheduledTaskGraphMaterialDriftTerminal: marker } },
    ...overrides,
  }
}

describe('scheduled Prepare material-drift stable projection', () => {
  it('matches only the newest owned scheduled Turn and its exact Root, Execution and terminal Gate child', () => {
    expect(scheduledMaterialDriftRecoveryReason(facts())).toBe(SCHEDULED_PREPARE_MATERIAL_DRIFT_RECOVERY_REASON)
    expect(scheduledMaterialDriftRecoveryReason(facts({ activeTurnId: null,
      turn: { ...facts().turn!, status: 'interrupted' }, gate: { ...facts().gate!, status: 'interrupted' },
      root: { ...facts().root!, status: 'interrupted' },
    }))).toBe(SCHEDULED_PREPARE_MATERIAL_DRIFT_RECOVERY_REASON)
  })

  it.each([
    ['foreign user', { userId: 'user_2' }],
    ['foreign session', { sessionId: 'session_2' }],
    ['superseded Turn', { newestTurnId: 'turn_2' }],
    ['another active Turn', { activeTurnId: 'turn_2' }],
  ])('hides a %s', (_label, overrides) => {
    expect(scheduledMaterialDriftRecoveryReason(facts(overrides))).toBeNull()
  })

  it.each([
    ['Turn id', { turn: { ...facts().turn!, id: 'turn_2' } }],
    ['Turn owner', { turn: { ...facts().turn!, userId: 'user_2' } }],
    ['Turn status', { turn: { ...facts().turn!, status: 'completed' } }],
    ['Turn mode', { turn: { ...facts().turn!, executionMode: 'legacy' } }],
    ['Turn lease version', { turn: { ...facts().turn!, leaseVersion: 5 } }],
    ['Root id', { root: { ...facts().root!, id: 'root_2' } }],
    ['Root attempt', { root: { ...facts().root!, attemptCount: 4 } }],
    ['Root parent', { root: { ...facts().root!, parentTaskId: 'parent_1' } }],
    ['Root role', { root: { ...facts().root!, role: 'prepare' } }],
    ['Gate id', { gate: { ...facts().gate!, id: 'gate_2' } }],
    ['Gate attempt', { gate: { ...facts().gate!, attemptCount: 3 } }],
    ['Gate parent', { gate: { ...facts().gate!, parentTaskId: 'root_2' } }],
    ['Gate depth', { gate: { ...facts().gate!, depth: 2 } }],
    ['Gate role', { gate: { ...facts().gate!, role: 'auditor' } }],
    ['Gate task type', { gate: { ...facts().gate!, taskType: 'other' } }],
    ['unknown Gate status', { gate: { ...facts().gate!, status: 'running' } }],
    ['Execution id', { execution: { ...facts().execution!, id: 'execution_2' } }],
    ['Execution attempt', { execution: { ...facts().execution!, attemptCount: 6 } }],
    ['Execution status', { execution: { ...facts().execution!, status: 'cancelled' } }],
    ['Execution error', { execution: { ...facts().execution!, error: 'private error' } }],
  ])('hides mismatched %s facts', (_label, overrides) => {
    expect(scheduledMaterialDriftRecoveryReason(facts(overrides))).toBeNull()
  })

  it('hides missing lineage and malformed, stale or ambiguous markers', () => {
    const valid = facts()
    const state = valid.execution!.state as Record<string, unknown>
    const terminal = state.scheduledTaskGraphMaterialDriftTerminal as Record<string, unknown>
    const malformed = { ...terminal, extra: 'not allowed' }
    const stale = { ...terminal, gate: { ...gateOwner, attemptCount: 9 } }
    const badDigest = { ...terminal, artifactDigest: 'private digest' }

    expect(scheduledMaterialDriftRecoveryReason(facts({ root: null }))).toBeNull()
    expect(scheduledMaterialDriftRecoveryReason(facts({ gate: null }))).toBeNull()
    for (const markerValue of [malformed, stale, badDigest, null]) {
      expect(scheduledMaterialDriftRecoveryReason(facts({
        execution: { ...valid.execution!, state: { scheduledTaskGraphMaterialDriftTerminal: markerValue } },
      }))).toBeNull()
    }
  })

  it('uses a private Gate id only as a tenant-scoped lookup hint', () => {
    expect(scheduledMaterialDriftGateTaskId({ scheduledTaskGraphMaterialDriftTerminal: marker })).toBe('gate_1')
    expect(scheduledMaterialDriftGateTaskId({ scheduledTaskGraphMaterialDriftTerminal: { gate: { taskId: {} } } })).toBeNull()
    expect(scheduledMaterialDriftGateTaskId(null)).toBeNull()
  })
})
