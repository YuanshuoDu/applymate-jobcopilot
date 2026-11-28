import type { StepContextSnapshot } from "../context/step-context-builder.js"
import { projectChildDiscoveryHistory } from "./child-discovery-history.js"
import type { ChildContextBuilder } from "./child-context.js"
import { isOrdinaryScout, type ChildPublicDefinition } from "./child-executor-admission.js"
import type { StructuredRole } from "./role-results.js"
import type { SubagentLease } from "./types.js"

type Input = Readonly<{
  lease: SubagentLease
  structuredRole: StructuredRole | undefined
  selectedJob: string | undefined
  selectedJobPreparation: unknown
  definitions: readonly ChildPublicDefinition[]
}>

function hasDiscoveryTransportTools(definitions: readonly ChildPublicDefinition[], actions: unknown): boolean {
  return ["jobs.discover", "tool_results.read"].every(name =>
    Array.isArray(actions) && actions.includes(name) &&
    definitions.some(definition => definition.name === name && definition.version === "1"))
}

/** Hides verified discovery transport rows from model context without changing canonical resume state. */
export function createChildDiscoveryModelContextBuilder(builder: ChildContextBuilder, input: Input): ChildContextBuilder {
  if (!isOrdinaryScout(input.lease, input.structuredRole, input.selectedJob, input.selectedJobPreparation)
    || !hasDiscoveryTransportTools(input.definitions, input.lease.allowedActions)) return builder
  return {
    build: request => {
      const snapshot = projectSnapshot(request.snapshot)
      return snapshot === request.snapshot ? builder.build(request) : builder.build({ ...request, snapshot })
    },
    getMailboxMessageIds: () => builder.getMailboxMessageIds(),
  }
}

function projectSnapshot(snapshot: StepContextSnapshot): StepContextSnapshot {
  const toolObservations = projectChildDiscoveryHistory(snapshot.toolObservations)
  return toolObservations === snapshot.toolObservations ? snapshot : { ...snapshot, toolObservations }
}
