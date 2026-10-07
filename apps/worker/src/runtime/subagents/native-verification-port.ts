import type { TaskGraphExecutionScope, TaskGraphReadScope } from "./task-graph-command-port.js"
import type pg from "pg"
import type { NativeVerificationDisposition, NativeVerificationReasonCode } from "./native-verification-contract.js"
import type { NativeSemanticRejectionIdentity } from "../turns/native-semantic-rejection-ledger.js"

/** Safe, bounded feedback from independently executed native verification controls. */
export type NativeVerificationFeedback = Readonly<{
  controlTaskId: string
  targetTaskId: string
  disposition: NativeVerificationDisposition
  criteria: readonly Readonly<{
    criterionId: string
    disposition: NativeVerificationDisposition
    reasonCode: NativeVerificationReasonCode
    evidenceReferenceIds: readonly string[]
  }>[]
}>

export type NativeVerificationEnsureResult = Readonly<{
  status: "passed" | "failed" | "uncertain" | "pending" | "unavailable"
  controlTaskIds: readonly string[]
  pendingControlTaskIds: readonly string[]
  /** Durable children and controls for the caller's normal wait path. */
  pendingTaskIds: readonly string[]
  feedback: readonly NativeVerificationFeedback[]
  rootGoalWitness?: NativeVerificationRootGoalWitness
}>

/** Server-generated witness for a root candidate review; never sufficient without readback. */
export type NativeVerificationRootGoalWitness = Readonly<{
  controlTaskId: string
  controlOperationId: string
  currentControlAttempt: number
  candidateDigest: string
  childBindingSetDigest: string
  goalDigest: string
  criteriaDigest: string
  evidencePacketDigest: string
  reportDigest: string
}>

export type NativeVerificationRecoverableGoal =
  | Readonly<{ controlTaskId: string; candidateText: string; status: "pending" | "passed"; feedback: NativeVerificationFeedback | null; witness?: NativeVerificationRootGoalWitness }>
  | Readonly<{ controlTaskId: string; candidateText: null; status: "failed" | "uncertain"; feedback: NativeVerificationFeedback | null }>

/**
 * PostgreSQL-backed producer/readback surface consumed by root integration.
 * Inputs carry only the executing root scope and, for goal reviews, the actual
 * candidate text. Goals, criteria, targets and evidence are loaded from storage.
 */
export type NativeVerificationPort = Readonly<{
  ensureChildren(scope: TaskGraphExecutionScope): Promise<NativeVerificationEnsureResult>
  ensureRootGoal(input: Readonly<{ scope: TaskGraphExecutionScope; candidateText: string }>): Promise<NativeVerificationEnsureResult>
  readRecoverableGoal(scope: TaskGraphReadScope): Promise<NativeVerificationRecoverableGoal | null>
  /** Private runtime read; never included in ensure/tool results or public feedback. */
  readFailedRootSemanticRejection?(input: Readonly<{ scope: TaskGraphExecutionScope; candidateText: string; controlTaskId: string }>): Promise<NativeSemanticRejectionIdentity | null>
}>

/** Terminal-only proof read: caller supplies its already-open transaction client. */
export type NativeVerificationTerminalProofReader = (
  client: Pick<pg.PoolClient, "query">,
  input: Readonly<{
    scope: TaskGraphReadScope
    candidateText: string
    witness: NativeVerificationRootGoalWitness
  }>,
) => Promise<boolean>

