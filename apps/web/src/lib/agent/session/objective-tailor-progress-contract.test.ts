import { describe, expect, it } from 'vitest'
import { OBJECTIVE_TAILOR_PROGRESS_HINT_SCHEMA, OBJECTIVE_TAILOR_PROGRESS_SCHEMA,
  parseObjectiveTailorProgress, parseObjectiveTailorProgressHint } from './objective-tailor-progress-contract'

const progress = () => ({ schemaVersion: OBJECTIVE_TAILOR_PROGRESS_SCHEMA,
  identity: { sessionId: 'session-1', turnId: 'turn-1', graphItemId: 'graph-1', rootTaskId: 'root-1', revision: 23 },
  sources: [{ ordinal: 1, role: 'scout', status: 'completed' }, { ordinal: 2, role: 'analyst', status: 'running' }],
  slots: [{ ordinal: 1, phase: 'drafting' }, { ordinal: 2, phase: 'awaiting_review' }] })

describe('objective tailor progress contract', () => {
  it('accepts only ordered bounded public progress and the tiny hint', () => {
    expect(parseObjectiveTailorProgress(progress())).toEqual(progress())
    const hint = { schemaVersion: OBJECTIVE_TAILOR_PROGRESS_HINT_SCHEMA, sourceNodeCount: 7, slotCount: 8 }
    expect(parseObjectiveTailorProgressHint(hint)).toEqual(hint)
    expect(parseObjectiveTailorProgressHint({ ...hint, privateProof: 'secret' })).toBeUndefined()
  })

  it('rejects extra, accessor, sparse, reordered, and unbounded progress', () => {
    expect(parseObjectiveTailorProgress({ ...progress(), privateProof: 'secret' })).toBeUndefined()
    expect(parseObjectiveTailorProgress({ ...progress(), slots: [{ ordinal: 2, phase: 'drafting' }] })).toBeUndefined()
    expect(parseObjectiveTailorProgress({ ...progress(), sources: [{ ordinal: 1, role: 'scout', status: 'future' }, { ordinal: 2, role: 'analyst', status: 'running' }] })).toBeUndefined()
    const sparse: unknown[] = new Array(2)
    sparse[1] = { ordinal: 2, phase: 'awaiting_review' }
    expect(parseObjectiveTailorProgress({ ...progress(), slots: sparse })).toBeUndefined()
    const accessor = Object.defineProperty(progress(), 'slots', { enumerable: true, get: () => [] })
    expect(parseObjectiveTailorProgress(accessor)).toBeUndefined()
    expect(parseObjectiveTailorProgressHint({ schemaVersion: OBJECTIVE_TAILOR_PROGRESS_HINT_SCHEMA, sourceNodeCount: 41, slotCount: 8 })).toBeUndefined()
  })
})
