import { isAfter } from './timeline-reducer-utils'
import { parsePlanLedgerEvent, PLAN_LEDGER_MAX_PLANS, PLAN_LEDGER_MAX_STEPS, type PlanLedgerEventEnvelope, type PlanLedgerStep } from './plan-ledger-parser'

interface PlanRecord {
  readonly key: string
  readonly scopeKey: string
  readonly turnId: string
  readonly taskId: string
  readonly planCallId: string
  readonly planRevision: number
  readonly goalRevision: number
  readonly sequence: string
  readonly steps: readonly StoredStep[]
  readonly observationIds: readonly string[]
}

interface StoredStep extends PlanLedgerStep { readonly sequence: string }
interface RevisionCursor { readonly key: string; readonly scopeKey: string; readonly goalRevision: number; readonly planCallId: string; readonly planRevision: number; readonly sequence: string }

export interface PlanLedgerPlan {
  readonly turnId: string
  readonly taskId: string
  readonly planRevision: number
  readonly goalRevision: number
  readonly steps: readonly PlanLedgerStep[]
}

export interface PlanLedgerState {
  readonly sessionId: string
  readonly plans: readonly PlanLedgerPlan[]
  readonly currentPlan: PlanLedgerPlan | null
  readonly records: readonly PlanRecord[]
  readonly cursors: readonly RevisionCursor[]
}

/** Redacted state intended for React consumers; receipt and observation IDs stay reducer-owned. */
export interface PlanLedgerProjection {
  readonly sessionId: string
  readonly plans: readonly PlanLedgerPlan[]
  readonly currentPlan: PlanLedgerPlan | null
}

export function createPlanLedgerState(sessionId: string): PlanLedgerState {
  return { sessionId, plans: [], currentPlan: null, records: [], cursors: [] }
}

/** Folds durable plan receipts into a bounded display-safe projection. */
export function reducePlanLedger(state: PlanLedgerState, value: unknown): PlanLedgerState {
  const event = parsePlanLedgerEvent(value, state.sessionId)
  if (!event) return state
  const scopeKey = `${event.turnId}\u0000${event.taskId}`
  if (event.receipt.kind === 'revision') return reduceRevision(state, event, scopeKey)
  return reduceStep(state, event, scopeKey)
}

function reduceRevision(state: PlanLedgerState, event: PlanLedgerEventEnvelope, scopeKey: string): PlanLedgerState {
  if (event.receipt.kind !== 'revision') return state
  const cursor = state.cursors.find(item => item.key === scopeKey)
  const receipt = event.receipt
  if (cursor && receipt.goalRevision < cursor.goalRevision) return state
  if (cursor) {
    if (receipt.goalRevision > cursor.goalRevision) {
      if (receipt.planRevision !== 1 || receipt.basedOnPlanRevision !== null) return state
    } else {
      if (receipt.planRevision < cursor.planRevision || receipt.planRevision === cursor.planRevision) return state
      if (receipt.planRevision !== cursor.planRevision + 1 || receipt.basedOnPlanRevision !== cursor.planRevision) return state
    }
  } else if (receipt.planRevision !== 1 || receipt.basedOnPlanRevision !== null) return state
  const key = `${scopeKey}\u0000${receipt.goalRevision}\u0000${receipt.planRevision}`
  const record: PlanRecord = { key, scopeKey, turnId: event.turnId, taskId: event.taskId, planCallId: receipt.planCallId, planRevision: receipt.planRevision, goalRevision: receipt.goalRevision, sequence: event.sequence, steps: [], observationIds: [] }
  const records = [...state.records.filter(item => item.key !== key), record].sort((left, right) => compareSequence(right.sequence, left.sequence)).slice(0, PLAN_LEDGER_MAX_PLANS)
  const cursors = [...state.cursors.filter(item => item.key !== scopeKey), { key: scopeKey, scopeKey, goalRevision: receipt.goalRevision, planCallId: receipt.planCallId, planRevision: receipt.planRevision, sequence: event.sequence }]
    .sort((left, right) => compareSequence(right.sequence, left.sequence)).slice(0, PLAN_LEDGER_MAX_PLANS)
  return projectState({ ...state, records, cursors })
}

function reduceStep(state: PlanLedgerState, event: PlanLedgerEventEnvelope, scopeKey: string): PlanLedgerState {
  if (event.receipt.kind !== 'step') return state
  const cursor = state.cursors.find(item => item.key === scopeKey)
  if (!cursor || cursor.planRevision !== event.receipt.planRevision || cursor.planCallId !== event.receipt.planCallId) return state
  const key = `${scopeKey}\u0000${cursor.goalRevision}\u0000${event.receipt.planRevision}`
  const index = state.records.findIndex(item => item.key === key)
  if (index < 0) return state
  const current = state.records[index]!
  if (current.planCallId !== event.receipt.planCallId || !isAfter(event.sequence, current.sequence) || current.observationIds.includes(event.receipt.observationId)) return state
  const nextStep: StoredStep = { ...event.receipt.step, sequence: event.sequence }
  const steps = [...current.steps.filter(step => step.localId !== nextStep.localId), nextStep]
    .sort((left, right) => compareSequence(left.sequence, right.sequence)).slice(-PLAN_LEDGER_MAX_STEPS)
  const updated: PlanRecord = { ...current, sequence: event.sequence, steps, observationIds: [...current.observationIds, event.receipt.observationId].slice(-PLAN_LEDGER_MAX_STEPS * 2) }
  const records = state.records.map((record, itemIndex) => itemIndex === index ? updated : record)
  return projectState({ ...state, records })
}

function projectState(state: PlanLedgerState): PlanLedgerState {
  const plans = state.records.map(record => ({
    turnId: record.turnId, taskId: record.taskId, planRevision: record.planRevision, goalRevision: record.goalRevision,
    steps: record.steps.map(({ sequence: _sequence, ...step }) => step),
  }))
  const currentCursor = state.cursors[0]
  const currentKey = currentCursor ? `${currentCursor.scopeKey}\u0000${currentCursor.goalRevision}\u0000${currentCursor.planRevision}` : null
  return { ...state, plans, currentPlan: plans.find((_, index) => state.records[index]?.key === currentKey) ?? null }
}

function compareSequence(left: string, right: string): number {
  const leftValue = BigInt(left)
  const rightValue = BigInt(right)
  return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1
}

export function selectPlanLedgerPlans(state: PlanLedgerState): readonly PlanLedgerPlan[] { return state.plans }

export function selectPlanLedgerProjection(state: PlanLedgerState): PlanLedgerProjection {
  return { sessionId: state.sessionId, plans: state.plans, currentPlan: state.currentPlan }
}
