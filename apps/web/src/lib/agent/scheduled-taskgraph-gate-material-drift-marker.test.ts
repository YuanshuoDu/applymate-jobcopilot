import { describe, expect, it } from 'vitest'
import { isScheduledTaskGraphGateMaterialDriftMarker } from './scheduled-taskgraph-gate-material-drift-marker'

const owner = { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1', rootAttemptCount: 2,
  turnLeaseOwnerId: 'turn-lease-1', turnLeaseVersion: 4, executionId: 'execution-1', executionAttemptCount: 7 }
const gate = { taskId: 'gate-1', leaseOwnerId: 'gate-lease-1', attemptCount: 3 }
const digest = (char: string) => `sha256:${char.repeat(64)}`
const markerState = (overrides: Record<string, unknown> = {}) => ({ scheduledTaskGraphMaterialDriftTerminal: {
  schemaVersion: 'agent-harness.v2.scheduled-prepare-material-drift-terminal.v1',
  reason: 'scheduled_prepare_material_source_changed', owner, gate,
  analyzeFingerprintDigest: digest('a'), prepareProofDigest: digest('b'), artifactDigest: digest('c'),
  currentMaterialDigest: digest('d'), proofDigest: digest('e'), ...overrides,
} })
const projectionInput = (state: unknown = markerState(), currentOwner = owner, currentGate = gate) => ({ owner: currentOwner, gate: currentGate, state })

describe('scheduled Gate material-drift terminal marker schema', () => {
  it('accepts an exact marker whose complete owner and Gate identity match', () => {
    expect(isScheduledTaskGraphGateMaterialDriftMarker(projectionInput())).toBe(true)
  })

  it('rejects any owner or Gate identity mismatch, including historical lease owner values', () => {
    expect(isScheduledTaskGraphGateMaterialDriftMarker(projectionInput(markerState(), { ...owner, turnId: 'other' }))).toBe(false)
    expect(isScheduledTaskGraphGateMaterialDriftMarker(projectionInput(markerState(), owner, { ...gate, attemptCount: 4 }))).toBe(false)
    const alteredOwner = { ...owner, turnLeaseOwnerId: 'other-lease' }
    expect(isScheduledTaskGraphGateMaterialDriftMarker(projectionInput(markerState(), alteredOwner))).toBe(false)
    const alteredGate = { ...gate, leaseOwnerId: 'other-gate-lease' }
    expect(isScheduledTaskGraphGateMaterialDriftMarker(projectionInput(markerState(), owner, alteredGate))).toBe(false)
  })

  it('rejects unknown keys, symbols, missing fields, wrong schema and malformed digests', () => {
    expect(isScheduledTaskGraphGateMaterialDriftMarker(projectionInput(markerState({ rawError: 'private' })))).toBe(false)
    const symbolState = markerState() as { scheduledTaskGraphMaterialDriftTerminal: Record<string, unknown> }
    Object.defineProperty(symbolState.scheduledTaskGraphMaterialDriftTerminal, Symbol('extra'), { value: 'hidden' })
    expect(isScheduledTaskGraphGateMaterialDriftMarker(projectionInput(symbolState))).toBe(false)
    expect(isScheduledTaskGraphGateMaterialDriftMarker(projectionInput(markerState({ proofDigest: undefined })))).toBe(false)
    expect(isScheduledTaskGraphGateMaterialDriftMarker(projectionInput(markerState({ schemaVersion: 'future' })))).toBe(false)
    expect(isScheduledTaskGraphGateMaterialDriftMarker(projectionInput(markerState({ artifactDigest: 'sha256:ABC' })))).toBe(false)
  })

  it('rejects non-plain marker state and invalid expected identities', () => {
    expect(isScheduledTaskGraphGateMaterialDriftMarker(projectionInput(Object.assign(Object.create({ inherited: true }), markerState())))).toBe(false)
    expect(isScheduledTaskGraphGateMaterialDriftMarker(projectionInput(markerState(), { ...owner, rootAttemptCount: 0 }))).toBe(false)
    expect(isScheduledTaskGraphGateMaterialDriftMarker(projectionInput(markerState(), owner, { ...gate, attemptCount: Number.MAX_SAFE_INTEGER + 1 }))).toBe(false)
  })
})
