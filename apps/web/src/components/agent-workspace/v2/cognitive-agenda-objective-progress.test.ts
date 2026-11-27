import { describe, expect, it } from 'vitest'

import { parseCognitiveAgendaObjectiveProgress } from './cognitive-agenda-objective-progress'

const location = { id: 'location_target', kind: 'candidate_location_in', locations: ['berlin', 'dublin'], status: 'reported_passed' }
const candidate = { id: 'candidate_target', kind: 'candidate_count_gte', minimum: 2, status: 'active' }
const finding = { id: 'finding_target', kind: 'finding_count_gte', minimum: 3, status: 'active' }

function receipt() {
  return {
    goalRevision: 'a'.repeat(64), planRevision: 5,
    objectiveProgressSnapshot: { schemaVersion: 'agent-harness.v2.objective-progress.v1', advisory: true, revision: 5,
      requirements: [location, candidate, finding] },
    progressDelta: { schemaVersion: 'agent-harness.v2.objective-progress-delta.v1', availability: 'available',
      previousPlanRevision: 4, currentPlanRevision: 5, requirements: [
        { id: 'location_target', kind: 'candidate_location_in', beforeStatus: 'active', afterStatus: 'reported_passed' },
        { id: 'candidate_target', kind: 'candidate_count_gte', minimum: 2, beforeStatus: 'active', afterStatus: 'active' },
        { id: 'finding_target', kind: 'finding_count_gte', minimum: 3, beforeStatus: 'unknown', afterStatus: 'active' },
      ] },
  }
}

describe('cognitive agenda objective progress projection', () => {
  it('projects Worker location and numeric requirements without IDs or location text', () => {
    const value = receipt()
    const progress = parseCognitiveAgendaObjectiveProgress(value)

    expect(progress).toEqual([
      { kind: 'candidate_location_in', status: 'reported_passed', beforeStatus: 'active' },
      { kind: 'candidate_count_gte', status: 'active', minimum: 2 },
      { kind: 'finding_count_gte', status: 'active', minimum: 3, beforeStatus: 'unknown' },
    ])
    expect(JSON.stringify(progress)).not.toContain('location_target')
    expect(JSON.stringify(progress)).not.toContain('candidate_target')
    expect(JSON.stringify(progress)).not.toContain('berlin')
    expect(JSON.stringify(progress)).not.toContain('dublin')
  })

  it('keeps unavailable history current-only and allows an empty unavailable snapshot', () => {
    const value = receipt()
    const unavailable = { ...value, goalRevision: null, progressDelta: { ...value.progressDelta,
      availability: 'unavailable', previousPlanRevision: null,
      requirements: value.progressDelta.requirements.map(row => ({ ...row, beforeStatus: 'unknown' })),
    } }
    expect(parseCognitiveAgendaObjectiveProgress(unavailable)?.every(row => !Object.hasOwn(row, 'beforeStatus'))).toBe(true)

    expect(parseCognitiveAgendaObjectiveProgress({ goalRevision: null, planRevision: 5, objectiveProgressSnapshot: null,
      progressDelta: { schemaVersion: 'agent-harness.v2.objective-progress-delta.v1', availability: 'unavailable',
        previousPlanRevision: null, currentPlanRevision: 5, requirements: [] } })).toEqual([])
  })

  it('rejects noncanonical location evidence, drifted row identity, and extra fields', () => {
    const value = receipt()
    const snapshot = value.objectiveProgressSnapshot
    expect(parseCognitiveAgendaObjectiveProgress({ ...value, objectiveProgressSnapshot: {
      ...snapshot, requirements: [{ ...location, locations: ['Berlin'] }, candidate, finding],
    } })).toBeNull()
    expect(parseCognitiveAgendaObjectiveProgress({ ...value, progressDelta: {
      ...value.progressDelta, requirements: value.progressDelta.requirements.map((row, index) => index === 0 ? { ...row, id: 'other' } : row),
    } })).toBeNull()
    expect(parseCognitiveAgendaObjectiveProgress({ ...value, objectiveProgressSnapshot: { ...snapshot, extra: true } })).toBeNull()
  })
})
