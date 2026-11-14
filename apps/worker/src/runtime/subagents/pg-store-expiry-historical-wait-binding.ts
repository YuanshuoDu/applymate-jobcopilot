import { buildHistoricalWaitBindingSql, CHILD_WAIT_HISTORICAL_WAIT_CORE_BINDING_SQL } from "./pg-store-expiry-historical-wait-binding-core.js"
import { historicalWaitClaimCollisionBindingSql } from "./pg-store-expiry-historical-wait-claim-collision-binding.js"
import type { HistoricalSourceStepPrefix } from "./pg-store-expiry-historical-source-step-prefix.js"

export type HistoricalWaitBinding = Readonly<{
  waitId: string
  sourceStepId: string
  sourceAttempt: number
  sourceCallItemId: string
  sourceCallId: string
  projectedSourceCallId: string
  sourceResultItemId: string
  sourceKeyDigest: string
  sourceLifecycleRecoveryOwnerDigest: string | null
  claimKeyDigest: string | null
  sourceKind: "normal_waiting" | "recovered"
  deadlineAt: string
  status: "ready" | "timed_out"
  mode: "any" | "all"
  targetTaskIds: readonly string[]
  matchedTaskIds: readonly string[]
  timeoutMs: number
}>

export type RecoveredWaitHandoff = Readonly<{
  schemaVersion: "recovered_wait_handoff.v2"
  waitId: string
  stepId: string
  attempt: number
  sourceCallItemId: string
  sourceCallId: string
  sourceResultItemId: string
  events: readonly Readonly<{ id: string; sequence: string; type: string; actor: string; itemId: string | null;
    correlationId: string; causationId: string | null; idempotencyKey: string; payloadDigest: string }>[]
  sourceStepPrefix: HistoricalSourceStepPrefix
}>

export type TerminalCallProjection = Readonly<{
  startEventId: string
  rawCallId: string
  projectedCallId: string
  callItemId: string
  stepId: string
  attempt: number
  sourceWait: HistoricalWaitBinding
  sourceStepPrefix?: HistoricalSourceStepPrefix
  sourceStepHandoff?: RecoveredWaitHandoff
  resultItemId?: string
  resultStartedEventId?: string
  resultCompletedEventId?: string
  stepCompletedEventId?: string
  stepToolChain?: unknown
}>

export { CHILD_WAIT_HISTORICAL_WAIT_CORE_BINDING_SQL }
export const CHILD_WAIT_HISTORICAL_WAIT_BINDING_SQL = buildHistoricalWaitBindingSql(
  historicalWaitClaimCollisionBindingSql(CHILD_WAIT_HISTORICAL_WAIT_CORE_BINDING_SQL))
