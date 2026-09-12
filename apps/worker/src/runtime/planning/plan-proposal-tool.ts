import { Type, type Static } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"

import { ToolExecutionError, type RuntimeToolDefinition } from "../tools/types.js"
import { copyAllowedPlanActions, PLAN_MAX_NODES, PLAN_MAX_REVISIONS, type GoalContract, type GoalContractRef, type PlanActionKind, type PlanProposal } from "./goal-plan-contract.js"
import { copyPlanFingerprints, fingerprintPlanProposal } from "./plan-fingerprint.js"
import { toRuntimeActionIntents, type RuntimeActionIntent } from "./goal-plan-actions.js"
import { PlanValidationError, validatePlanProposal } from "./goal-plan-validator.js"
import { PlanRevisionRecoveryError, recoverPlanRevision, type PlanRevisionRecoveryDispatcher } from "./plan-revision-receipt.js"

const PlanProposalEnvelopeSchema = Type.Object({ proposal: Type.Unknown() }, { additionalProperties: false })
const PlanProposalOutputSchema = Type.Object({
  status: Type.Literal("accepted"), goalRevision: Type.Integer({ minimum: 1 }), planRevision: Type.Integer({ minimum: 1 }),
  basedOnPlanRevision: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]), proposal: Type.Unknown(), intents: Type.Array(Type.Unknown(), { maxItems: 8 }),
  proposalHash: Type.String({ pattern: "^sha256:[0-9a-f]{64}$", minLength: 71, maxLength: 71 }),
}, { additionalProperties: false })

export type PlanProposalToolInput = Static<typeof PlanProposalEnvelopeSchema>
export type PlanProposalToolOutput = {
  readonly status: "accepted"
  readonly goalRevision: number
  readonly planRevision: number
  readonly basedOnPlanRevision: number | null
  readonly proposal: PlanProposal
  readonly intents: readonly RuntimeActionIntent[]
  readonly proposalHash: string
}

export type PlanProposalToolOptions = {
  readonly goal: GoalContract
  readonly goalRef?: GoalContractRef
  readonly allowedTools: readonly string[]
  readonly allowedTemplates: readonly string[]
  readonly allowedRoles: readonly string[]
  /** Server-owned action capability gate; omitted means all plan actions remain compatible. */
  readonly allowedPlanActions?: readonly PlanActionKind[]
  readonly maxNodes: number
  /** Recovered durable revision; null means no accepted proposal exists yet. */
  readonly initialPlanRevision?: number | null
  /** Server-owned upper bound for accepted revisions. */
  readonly maxPlanRevisions?: number
  /** Server-owned hashes recovered from prior accepted proposals. */
  readonly initialPlanHashes?: readonly string[]
  /** Runtime-owned dispatcher used only to repair a persisted replay receipt. */
  readonly recoveryDispatcher?: PlanRevisionRecoveryDispatcher
}

function copyAllowlist(name: string, value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new TypeError(`Invalid ${name} allowlist`)
  return Object.freeze([...value])
}

export function createPlanProposalTool(options: PlanProposalToolOptions): RuntimeToolDefinition<PlanProposalToolInput, PlanProposalToolOutput> {
  if (!Number.isSafeInteger(options.goal?.revision) || options.goal.revision < 1) throw new TypeError("Plan goal revision must be a positive integer")
  if (!Number.isSafeInteger(options.maxNodes) || options.maxNodes < 1 || options.maxNodes > PLAN_MAX_NODES) throw new TypeError(`Plan maxNodes must be between 1 and ${PLAN_MAX_NODES}`)
  const maxPlanRevisions = options.maxPlanRevisions ?? PLAN_MAX_REVISIONS
  if (!Number.isSafeInteger(maxPlanRevisions) || maxPlanRevisions < 1 || maxPlanRevisions > PLAN_MAX_REVISIONS) throw new TypeError(`Plan maxPlanRevisions must be between 1 and ${PLAN_MAX_REVISIONS}`)
  if (options.initialPlanRevision !== undefined && options.initialPlanRevision !== null && (!Number.isSafeInteger(options.initialPlanRevision) || options.initialPlanRevision < 1 || options.initialPlanRevision > maxPlanRevisions)) throw new TypeError("Invalid initial plan revision")
  const allowedTools = copyAllowlist("tool", options.allowedTools)
  const allowedTemplates = copyAllowlist("template", options.allowedTemplates)
  const allowedRoles = copyAllowlist("role", options.allowedRoles)
  const allowedPlanActions = copyAllowedPlanActions(options.allowedPlanActions)
  const seenPlanHashes = new Set(copyPlanFingerprints(options.initialPlanHashes))
  let planRevision: number | null = options.initialPlanRevision ?? null
  let goalRevision = options.goal.revision
  options.recoveryDispatcher?.register(receipt => {
    const goal = options.goalRef?.get() ?? options.goal
    recoverPlanRevision(receipt.basedOnPlanRevision, receipt, maxPlanRevisions)
    const previousPlanRevision = planRevision
    const previousGoalRevision = goalRevision
    const previousPlanHashes = [...seenPlanHashes]
    const goalChanged = goal.revision !== goalRevision
    const recoveryPlanRevision = goalChanged ? null : planRevision
    const recoveryPlanHashes = goalChanged ? new Set<string>() : seenPlanHashes
    if (receipt.goalRevision !== goal.revision) {
      if (!goalChanged) return
      return {
        commit: () => {
          goalRevision = goal.revision
          planRevision = null
          seenPlanHashes.clear()
        },
        rollback: () => {
          goalRevision = previousGoalRevision
          planRevision = previousPlanRevision
          seenPlanHashes.clear()
          for (const hash of previousPlanHashes) seenPlanHashes.add(hash)
        },
      }
    }
    const nextRevision = recoverPlanRevision(recoveryPlanRevision, receipt, maxPlanRevisions)
    if (receipt.planRevision === recoveryPlanRevision) {
      if (receipt.proposalHash && !recoveryPlanHashes.has(receipt.proposalHash)) throw new PlanRevisionRecoveryError()
    } else if (receipt.proposalHash && recoveryPlanHashes.has(receipt.proposalHash)) throw new PlanRevisionRecoveryError()
    const nextPlanHashes = new Set(recoveryPlanHashes)
    if (receipt.proposalHash) nextPlanHashes.add(receipt.proposalHash)
    return {
      commit: () => {
        goalRevision = goal.revision
        planRevision = nextRevision
        seenPlanHashes.clear()
        for (const hash of nextPlanHashes) seenPlanHashes.add(hash)
      },
      rollback: () => {
        goalRevision = previousGoalRevision
        planRevision = previousPlanRevision
        seenPlanHashes.clear()
        for (const hash of previousPlanHashes) seenPlanHashes.add(hash)
      },
    }
  })
  return {
    schemaVersion, name: "agent.plan.propose", version: "1", description: "Propose a bounded read-only plan for the current goal",
    capabilities: ["coordination"], inputSchema: PlanProposalEnvelopeSchema, outputSchema: PlanProposalOutputSchema,
    risk: "internal_write", domain: "coordination", idempotency: "idempotent", timeoutMs: 10_000, requiredCapabilities: ["canPlan"],
    execute: async (_context, input) => {
      try {
        const goal = options.goalRef?.get() ?? options.goal
        if (goal.revision !== goalRevision) {
          planRevision = null
          seenPlanHashes.clear()
          goalRevision = goal.revision
        }
        const nextRevision = (planRevision ?? 0) + 1
        if (nextRevision > maxPlanRevisions) throw new ToolExecutionError("plan_revision_limit", "Plan revision limit reached", { maxPlanRevisions })
        const proposal = validatePlanProposal(input.proposal, {
          goalRevision: goal.revision, planRevision, maxNodes: options.maxNodes,
          allowedActions: allowedPlanActions, allowedTools,
          allowedTemplates, allowedRoles,
        })
        const proposalHash = fingerprintPlanProposal(proposal)
        if (seenPlanHashes.has(proposalHash)) throw new ToolExecutionError("plan_no_progress", "Plan proposal repeats an accepted semantic plan", { proposalHash })
        const basedOnPlanRevision = planRevision
        planRevision = nextRevision
        seenPlanHashes.add(proposalHash)
        return { status: "accepted" as const, goalRevision: goal.revision, planRevision, basedOnPlanRevision, proposal, intents: toRuntimeActionIntents(proposal), proposalHash }
      } catch (error: unknown) {
        if (error instanceof PlanValidationError) throw new ToolExecutionError("plan_invalid", "Plan proposal failed deterministic validation", { issues: error.issues.slice(0, 16).map(issue => ({ path: issue.path.slice(0, 256), code: issue.code.slice(0, 64), message: issue.message.slice(0, 256) })) })
        throw error
      }
    },
  }
}
