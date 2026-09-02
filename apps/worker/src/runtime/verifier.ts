import type { StepContextSnapshot } from "./context/step-context-builder.js"

export type FinalCandidate = {
  readonly text: string
  readonly finishReason: string
  readonly evidenceRefs?: readonly string[]
}

export type FinalEvidence = {
  readonly id: string
  readonly status?: "verified" | "conflicting" | "missing"
}

export type BusinessCheck = {
  readonly name: string
  readonly ok: boolean
  readonly message?: string
}

export type FinalVerification =
  | { readonly ok: true; readonly evidenceRefs: readonly string[]; readonly businessChecks: readonly BusinessCheck[] }
  | { readonly ok: false; readonly code: "final_unverified" | "evidence_missing" | "evidence_conflict" | "business_precondition_failed"; readonly blocker: string; readonly feedback: string; readonly evidenceRefs: readonly string[]; readonly businessChecks: readonly BusinessCheck[] }

export type VerifyCandidateInput = {
  readonly goal: string
  readonly candidate: FinalCandidate
  readonly evidence?: readonly FinalEvidence[]
  readonly expectedEvidence?: readonly string[]
  readonly businessChecks?: readonly BusinessCheck[]
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort()
}

export function snapshotEvidence(snapshot: StepContextSnapshot): FinalEvidence[] {
  const business = snapshot.businessRefs.map((reference) => ({ id: reference.id, status: "verified" as const }))
  const observations = snapshot.toolObservations.flatMap((observation) => {
    if (!observation.content || typeof observation.content !== "object" || Array.isArray(observation.content)) return []
    const content = observation.content as Record<string, unknown>
    if (typeof content.toolCallId !== "string") return []
    return [{ id: content.toolCallId, status: content.status === "completed" ? "verified" as const : "conflicting" as const }]
  })
  return [...business, ...observations]
}

export function verifyCandidateFinal(input: VerifyCandidateInput): FinalVerification {
  const text = input.candidate.text.trim()
  const evidence = input.evidence ?? []
  const evidenceRefs = uniqueSorted(input.candidate.evidenceRefs ?? evidence.map((entry) => entry.id))
  const businessChecks = [...(input.businessChecks ?? [])].sort((left, right) => left.name.localeCompare(right.name))
  if (input.candidate.finishReason !== "stop" || text.length === 0) {
    return rejected("final_unverified", "The model did not provide a completed candidate response", "A final response requires a non-empty stop response", evidenceRefs, businessChecks)
  }
  const expected = uniqueSorted(input.expectedEvidence ?? [])
  const available = new Map(evidence.map((entry) => [entry.id, entry.status ?? "verified"]))
  const requiredRefs = uniqueSorted([...expected, ...evidenceRefs])
  const missing = requiredRefs.filter((id) => !available.has(id) || available.get(id) === "missing")
  if (missing.length > 0 || (expected.length === 0 && evidenceRefs.length === 0)) {
    const blocker = missing.length > 0 ? `Missing evidence: ${missing.join(", ")}` : "No verifiable evidence is attached to the candidate final"
    return rejected("evidence_missing", blocker, "Attach verified business or tool evidence before claiming completion", evidenceRefs, businessChecks)
  }
  const conflicting = requiredRefs.filter((id) => available.get(id) === "conflicting")
  if (conflicting.length > 0) return rejected("evidence_conflict", `Conflicting evidence: ${conflicting.join(", ")}`, "Resolve conflicting evidence before claiming completion", evidenceRefs, businessChecks)
  const failed = businessChecks.filter((check) => !check.ok)
  if (failed.length > 0) return rejected("business_precondition_failed", failed.map((check) => check.message ?? check.name).join("; "), "Complete the business prerequisites before claiming completion", evidenceRefs, businessChecks)
  return { ok: true, evidenceRefs, businessChecks }
}

function rejected(code: Extract<FinalVerification, { ok: false }>["code"], blocker: string, feedback: string, evidenceRefs: readonly string[], businessChecks: readonly BusinessCheck[]): Extract<FinalVerification, { ok: false }> {
  return { ok: false, code, blocker, feedback, evidenceRefs, businessChecks }
}
