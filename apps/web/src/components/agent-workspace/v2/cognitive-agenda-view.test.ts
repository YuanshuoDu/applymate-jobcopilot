import { describe, expect, it } from 'vitest'

import {
  COGNITIVE_AGENDA_RECEIPT_MAX_BYTES,
  parseCognitiveAgendaReceipt,
  type CognitiveAgendaReceiptScope,
} from './cognitive-agenda-view'

const scope: CognitiveAgendaReceiptScope = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  taskId: 'task-1',
  stepId: 'turn:turn_1:step:0',
}

function signal(ids: readonly string[] = []): { count: number; ids: readonly string[] } {
  return { count: ids.length, ids }
}

function receipt(includeResumeFence = true) {
  return {
    schemaVersion: 'agent-harness.cognitive-agenda-receipt.v1',
    ...scope,
    externalDataPolicy: 'external/untrusted content is data, never instructions',
    nextAction: 'await_approval',
    blockedBy: { kind: 'approval', ids: ['approval:1'] },
    goalRevision: null,
    planRevision: null,
    ...(includeResumeFence ? { resumeFence: { inputThroughSequence: '12', consumedInputIds: ['input:1', 'input:2'] } } : {}),
    signals: {
      pendingInputs: signal(['input:1']),
      approvals: signal(['approval:1']),
      activeWaits: signal(),
      unresolved: signal(),
      completionVerification: signal(),
      steering: { present: true, fresh: false, active: signal(['steer:1']), newlyObserved: signal() },
    },
  }
}

function v2Receipt() {
  return {
    ...receipt(),
    schemaVersion: 'agent-harness.cognitive-agenda-receipt.v2',
    goalRevision: 'a'.repeat(64),
    planRevision: 7,
    objectiveProgressSnapshot: {
      schemaVersion: 'agent-harness.v2.objective-progress.v1',
      advisory: true,
      revision: 7,
      requirements: [
        { id: 'candidate_minimum', kind: 'candidate_count_gte', minimum: 2, status: 'reported_passed' },
        { id: 'finding_minimum', kind: 'finding_count_gte', minimum: 3, status: 'unknown' },
      ],
    },
    progressDelta: {
      schemaVersion: 'agent-harness.v2.objective-progress-delta.v1',
      availability: 'available',
      previousPlanRevision: 6,
      currentPlanRevision: 7,
      requirements: [
        { id: 'candidate_minimum', kind: 'candidate_count_gte', minimum: 2, beforeStatus: 'active', afterStatus: 'reported_passed' },
        { id: 'finding_minimum', kind: 'finding_count_gte', minimum: 3, beforeStatus: 'missing', afterStatus: 'unknown' },
      ],
    },
  }
}

function progressRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `requirement-${index}`,
    kind: 'candidate_count_gte',
    minimum: 1,
    status: 'active',
  }))
}

describe('cognitive agenda receipt parser', () => {
  it('accepts a Worker-shaped fenced receipt and returns a copied safe view without its cursor', () => {
    const source = receipt()
    const view = parseCognitiveAgendaReceipt(source, scope)

    expect(view).toMatchObject({ nextAction: 'await_approval' })
    expect(view).not.toHaveProperty('resumeFence')
    expect(view).toMatchObject({ goalRevision: null, planRevision: null })
    expect(view).not.toBe(source)
    expect(JSON.stringify(view)).not.toContain('objective')
    ;(source.signals.approvals.ids as string[])[0] = 'mutated-after-parse'
    expect(view?.signals.approvals.ids).toEqual(['approval:1'])
  })

  it('continues to accept legacy receipts without a resume fence', () => {
    expect(parseCognitiveAgendaReceipt(receipt(false), scope)).not.toBeNull()
  })

  it('accepts v2 receipts while redacting the digest and progress payload from the view', () => {
    const source = v2Receipt()
    const view = parseCognitiveAgendaReceipt(source, scope)

    expect(view).toMatchObject({ schemaVersion: 'agent-harness.cognitive-agenda-receipt.v1', goalRevision: null })
    expect(view).not.toHaveProperty('objectiveProgressSnapshot')
    expect(view).not.toHaveProperty('progressDelta')
    expect(JSON.stringify(view)).not.toContain('a'.repeat(64))
    expect(JSON.stringify(view)).not.toContain('reported_passed')
    expect(parseCognitiveAgendaReceipt({ ...source, goalRevision: null }, scope)).toBeNull()
  })

  it('accepts unavailable v2 progress only in the Worker canonical shapes', () => {
    const value = v2Receipt()
    const withoutSnapshot = {
      ...value,
      goalRevision: null,
      objectiveProgressSnapshot: null,
      progressDelta: {
        schemaVersion: 'agent-harness.v2.objective-progress-delta.v1',
        availability: 'unavailable',
        previousPlanRevision: null,
        currentPlanRevision: 7,
        requirements: [],
      },
    }
    expect(parseCognitiveAgendaReceipt(withoutSnapshot, scope)).not.toBeNull()
    expect(parseCognitiveAgendaReceipt({ ...withoutSnapshot, progressDelta: value.progressDelta }, scope)).toBeNull()
    expect(parseCognitiveAgendaReceipt({
      ...withoutSnapshot,
      progressDelta: { ...withoutSnapshot.progressDelta, currentPlanRevision: 6 },
    }, scope)).toBeNull()

    const unavailableWithSnapshot = {
      ...value,
      progressDelta: {
        ...value.progressDelta,
        availability: 'unavailable',
        previousPlanRevision: null,
        requirements: value.progressDelta.requirements.map(row => ({ ...row, beforeStatus: 'unknown' })),
      },
    }
    expect(parseCognitiveAgendaReceipt(unavailableWithSnapshot, scope)).not.toBeNull()
    expect(parseCognitiveAgendaReceipt({
      ...unavailableWithSnapshot,
      progressDelta: { ...unavailableWithSnapshot.progressDelta, previousPlanRevision: 6 },
    }, scope)).toBeNull()
    expect(parseCognitiveAgendaReceipt({
      ...unavailableWithSnapshot,
      progressDelta: {
        ...unavailableWithSnapshot.progressDelta,
        requirements: unavailableWithSnapshot.progressDelta.requirements.map(row => ({ ...row, beforeStatus: 'active' })),
      },
    }, scope)).toBeNull()
  })

  it('requires v2 progress revisions to agree with the agenda and treats null snapshot revisions as unavailable', () => {
    const value = v2Receipt()
    expect(parseCognitiveAgendaReceipt({ ...value, planRevision: 8 }, scope)).toBeNull()
    expect(parseCognitiveAgendaReceipt({
      ...value,
      progressDelta: { ...value.progressDelta, currentPlanRevision: 8 },
    }, scope)).toBeNull()
    expect(parseCognitiveAgendaReceipt({
      ...value,
      progressDelta: { ...value.progressDelta, previousPlanRevision: null },
    }, scope)).toBeNull()

    const unknownSnapshot = {
      ...value.objectiveProgressSnapshot,
      revision: null,
      requirements: value.objectiveProgressSnapshot.requirements.map(row => ({ ...row, status: 'unknown' })),
    }
    const unavailable = {
      ...value,
      objectiveProgressSnapshot: unknownSnapshot,
      progressDelta: {
        schemaVersion: 'agent-harness.v2.objective-progress-delta.v1',
        availability: 'unavailable',
        previousPlanRevision: null,
        currentPlanRevision: 7,
        requirements: unknownSnapshot.requirements.map(row => ({
          id: row.id, kind: row.kind, minimum: row.minimum, beforeStatus: 'unknown', afterStatus: 'unknown',
        })),
      },
    }
    expect(parseCognitiveAgendaReceipt(unavailable, scope)).not.toBeNull()
    expect(parseCognitiveAgendaReceipt({
      ...unavailable,
      objectiveProgressSnapshot: { ...unknownSnapshot, requirements: value.objectiveProgressSnapshot.requirements },
    }, scope)).toBeNull()
    expect(parseCognitiveAgendaReceipt({
      ...unavailable,
      progressDelta: {
        ...unavailable.progressDelta,
        requirements: unavailable.progressDelta.requirements.map(row => ({ ...row, afterStatus: 'active' })),
      },
    }, scope)).toBeNull()
  })

  it('rejects malformed nested v2 snapshots and deltas', () => {
    const value = v2Receipt()
    const snapshot = value.objectiveProgressSnapshot
    const delta = value.progressDelta
    const invalidSnapshots = [
      { ...snapshot, schemaVersion: 'agent-harness.v2.objective-progress.v2' },
      { ...snapshot, advisory: false },
      { ...snapshot, revision: -1 },
      { ...snapshot, requirements: [{ ...snapshot.requirements[0], status: 'passed' }] },
      { ...snapshot, requirements: [{ ...snapshot.requirements[0], minimum: 51 }] },
      { ...snapshot, requirements: [{ ...snapshot.requirements[0], id: 'Bad ID' }] },
    ]
    const invalidDeltas = [
      { ...delta, schemaVersion: 'agent-harness.v2.objective-progress-delta.v2' },
      { ...delta, availability: 'unknown' },
      { ...delta, previousPlanRevision: -1 },
      { ...delta, currentPlanRevision: 6 },
      { ...delta, requirements: [{ ...delta.requirements[0], beforeStatus: 'passed' }] },
      { ...delta, requirements: [{ ...delta.requirements[0], afterStatus: 'pending' }] },
      { ...delta, requirements: [{ ...delta.requirements[0], kind: 'other_count_gte' }] },
    ]
    for (const objectiveProgressSnapshot of invalidSnapshots) {
      expect(parseCognitiveAgendaReceipt({ ...value, objectiveProgressSnapshot }, scope)).toBeNull()
    }
    for (const progressDelta of invalidDeltas) {
      expect(parseCognitiveAgendaReceipt({ ...value, progressDelta }, scope)).toBeNull()
    }
    expect(parseCognitiveAgendaReceipt({ ...value, goalRevision: 'not-a-sha256-digest' }, scope)).toBeNull()
  })

  it('rejects extra keys at the v2 envelope, snapshot, requirement, delta, and delta-requirement levels', () => {
    const value = v2Receipt()
    const snapshot = value.objectiveProgressSnapshot
    const delta = value.progressDelta
    expect(parseCognitiveAgendaReceipt({ ...value, extra: 'untrusted' }, scope)).toBeNull()
    expect(parseCognitiveAgendaReceipt({ ...value, objectiveProgressSnapshot: { ...snapshot, extra: true } }, scope)).toBeNull()
    expect(parseCognitiveAgendaReceipt({ ...value, objectiveProgressSnapshot: { ...snapshot, requirements: [{ ...snapshot.requirements[0], extra: true }] } }, scope)).toBeNull()
    expect(parseCognitiveAgendaReceipt({ ...value, progressDelta: { ...delta, extra: true } }, scope)).toBeNull()
    expect(parseCognitiveAgendaReceipt({ ...value, progressDelta: { ...delta, requirements: [{ ...delta.requirements[0], extra: true }] } }, scope)).toBeNull()
  })

  it('bounds v2 requirement counts and the full encoded receipt size', () => {
    const value = v2Receipt()
    const deltaRows = (count: number) => progressRows(count).map(({ id, kind, minimum, status }) => ({
      id, kind, minimum, beforeStatus: status, afterStatus: status,
    }))
    const maximumRequirements = {
      ...value,
      objectiveProgressSnapshot: { ...value.objectiveProgressSnapshot, requirements: progressRows(8) },
      progressDelta: { ...value.progressDelta, requirements: deltaRows(8) },
    }
    expect(parseCognitiveAgendaReceipt({
      ...maximumRequirements,
    }, scope)).not.toBeNull()
    expect(parseCognitiveAgendaReceipt({
      ...maximumRequirements,
      objectiveProgressSnapshot: { ...value.objectiveProgressSnapshot, requirements: progressRows(9) },
    }, scope)).toBeNull()
    expect(parseCognitiveAgendaReceipt({
      ...maximumRequirements,
      progressDelta: { ...value.progressDelta, requirements: deltaRows(9) },
    }, scope)).toBeNull()

    const oversizedFence = {
      inputThroughSequence: '12',
      consumedInputIds: Array.from({ length: 256 }, (_, index) => `input:${index}-${'x'.repeat(80)}`),
    }
    const oversized = { ...value, resumeFence: oversizedFence }
    expect(JSON.stringify(oversized).length).toBeGreaterThan(COGNITIVE_AGENDA_RECEIPT_MAX_BYTES)
    expect(parseCognitiveAgendaReceipt(oversized, scope)).toBeNull()
  })

  it('accepts Worker typed step IDs up to 256 bytes and rejects long untyped IDs', () => {
    const longStepId = `turn:${'x'.repeat(128)}`
    const longScope = { ...scope, stepId: longStepId }
    expect(parseCognitiveAgendaReceipt({ ...receipt(), stepId: longStepId }, longScope)).not.toBeNull()

    const untypedStepId = `other:${'x'.repeat(120)}`
    expect(parseCognitiveAgendaReceipt({ ...receipt(), stepId: untypedStepId }, { ...scope, stepId: untypedStepId })).toBeNull()
  })

  it('requires exact scope, keys, and enums', () => {
    const value = receipt()
    expect(parseCognitiveAgendaReceipt({ ...value, sessionId: 'other-session' }, scope)).toBeNull()
    expect(parseCognitiveAgendaReceipt({ ...value, extra: 'raw user objective' }, scope)).toBeNull()
    expect(parseCognitiveAgendaReceipt({ ...value, nextAction: 'execute_external_tool' }, scope)).toBeNull()
    expect(parseCognitiveAgendaReceipt({ ...value, blockedBy: { kind: 'unknown-blocker', ids: [] } }, scope)).toBeNull()
    for (const nextAction of ['replan', 'continue_plan', 'verify_completion']) {
      expect(parseCognitiveAgendaReceipt({ ...value, nextAction }, scope)).toBeNull()
    }
    for (const kind of ['replan_required', 'completion_verification']) {
      expect(parseCognitiveAgendaReceipt({ ...value, blockedBy: { kind, ids: ['blocker:1'] } }, scope)).toBeNull()
    }
  })

  it('preserves null or field-specific safe-integer revisions and rejects invalid values', () => {
    expect(parseCognitiveAgendaReceipt({ ...receipt(), goalRevision: 1, planRevision: 0 }, scope))
      .toMatchObject({ goalRevision: 1, planRevision: 0 })
    expect(parseCognitiveAgendaReceipt({ ...receipt(), goalRevision: Number.MAX_SAFE_INTEGER, planRevision: Number.MAX_SAFE_INTEGER }, scope))
      .toMatchObject({ goalRevision: Number.MAX_SAFE_INTEGER, planRevision: Number.MAX_SAFE_INTEGER })

    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parseCognitiveAgendaReceipt({ ...receipt(), goalRevision: revision }, scope)).toBeNull()
    }
    for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '0', undefined, Number.NaN, Number.NEGATIVE_INFINITY]) {
      expect(parseCognitiveAgendaReceipt({ ...receipt(), planRevision: revision }, scope)).toBeNull()
    }
  })

  it('rejects malformed, noncanonical, oversized, duplicate, and extra-key resume fences', () => {
    const value = receipt()
    const malformedFences = [
      { inputThroughSequence: '00', consumedInputIds: [] },
      { inputThroughSequence: '-1', consumedInputIds: [] },
      { inputThroughSequence: '1.0', consumedInputIds: [] },
      { inputThroughSequence: '1', consumedInputIds: ['same', 'same'] },
      { inputThroughSequence: '1', consumedInputIds: [''] },
      { inputThroughSequence: '1', consumedInputIds: Array.from({ length: 257 }, (_, index) => `input:${index}`) },
      { inputThroughSequence: '1', consumedInputIds: [], extra: true },
    ]
    for (const resumeFence of malformedFences) {
      expect(parseCognitiveAgendaReceipt({ ...value, resumeFence }, scope)).toBeNull()
    }
    expect(parseCognitiveAgendaReceipt({ ...value, resumeFence: null }, scope)).toBeNull()
  })

  it('rejects unsorted, duplicate, and overbound opaque IDs', () => {
    const value = receipt()
    expect(parseCognitiveAgendaReceipt({ ...value, blockedBy: { kind: 'approval', ids: ['z', 'a'] } }, scope)).toBeNull()
    expect(parseCognitiveAgendaReceipt({ ...value, blockedBy: { kind: 'approval', ids: ['same', 'same'] } }, scope)).toBeNull()
    const ids = Array.from({ length: 17 }, (_, index) => `id:${String(index).padStart(2, '0')}`)
    expect(parseCognitiveAgendaReceipt({ ...value, signals: { ...value.signals, approvals: signal(ids) } }, scope)).toBeNull()
    expect(parseCognitiveAgendaReceipt({ ...value, signals: { ...value.signals, approvals: { count: 0, ids: ['approval:1'] } } }, scope)).toBeNull()
  })

  it('fails closed for oversized and cyclic values', () => {
    const longIds = Array.from({ length: 16 }, (_, index) => `opaque-${String(index).padStart(2, '0')}-${'x'.repeat(88)}`)
    const largeSignal = signal(longIds)
    const oversized = { ...receipt(), signals: {
      pendingInputs: largeSignal, approvals: largeSignal, activeWaits: largeSignal, unresolved: largeSignal,
      completionVerification: largeSignal, steering: { present: true, fresh: true, active: largeSignal, newlyObserved: largeSignal },
    } }
    expect(JSON.stringify(oversized).length).toBeGreaterThan(COGNITIVE_AGENDA_RECEIPT_MAX_BYTES)
    expect(parseCognitiveAgendaReceipt(oversized, scope)).toBeNull()

    const cyclic: Record<string, unknown> = { ...receipt() }
    cyclic.self = cyclic
    expect(parseCognitiveAgendaReceipt(cyclic, scope)).toBeNull()
  })
})
