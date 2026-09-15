import type { PlanNode, PlanProposal } from "./goal-plan-contract.js"

export type RuntimeActionBase = {
  readonly localId: string
  readonly objective: string
  readonly inputRefs: readonly string[]
  readonly dependsOn: readonly string[]
  readonly successCriteria: readonly string[]
  readonly outputSchemaRef: string | null
}

export type RuntimeActionIntent =
  | (RuntimeActionBase & { readonly kind: "use_tool"; readonly toolName: string; readonly template?: string })
  | (RuntimeActionBase & { readonly kind: "delegate"; readonly role: string; readonly taskType: string; readonly goal: string; readonly constraints: readonly string[] })
  | (RuntimeActionBase & { readonly kind: "request_input"; readonly question: string; readonly approvalBoundary?: string })
  | (RuntimeActionBase & { readonly kind: "propose_completion" })

function base(node: PlanNode): RuntimeActionBase {
  return {
    localId: node.localId, objective: node.objective, inputRefs: [...node.inputRefs], dependsOn: [...node.dependsOn],
    successCriteria: [...node.successCriteria], outputSchemaRef: node.outputSchemaRef,
  }
}

function intent(node: PlanNode): RuntimeActionIntent {
  const shared = base(node)
  if (node.kind === "use_tool") return { ...shared, kind: "use_tool", toolName: node.toolName ?? node.tool ?? "", ...(node.template ? { template: node.template } : {}) }
  if (node.kind === "delegate") return { ...shared, kind: "delegate", role: node.role ?? "", taskType: node.taskType ?? "", goal: node.objective, constraints: [...(node.constraints ?? [])] }
  if (node.kind === "request_input") return { ...shared, kind: "request_input", question: node.question ?? node.objective, ...(node.approvalBoundary ? { approvalBoundary: node.approvalBoundary } : {}) }
  return { ...shared, kind: "propose_completion" }
}

/** Converts a validated proposal without assigning runtime identity or hard limits. */
export function toRuntimeActionIntents(proposal: PlanProposal): readonly RuntimeActionIntent[] {
  return proposal.nodes.map(intent)
}

export const planProposalToIntents = toRuntimeActionIntents
export const createRuntimeActionIntents = toRuntimeActionIntents
