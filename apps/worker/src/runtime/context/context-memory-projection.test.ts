import { describe, expect, it } from "vitest"

import type { StepContextSnapshot } from "./step-context-builder.js"
import { buildContextMemoryProjection, isContextMemoryAnchorObservation } from "./context-memory-projection.js"

const base: StepContextSnapshot = {
  system: [{ id: "constraint-system", content: "Use only approved tools" }],
  profile: [],
  goal: { id: "goal-current", content: { revision: 2, objective: "Find a role" } },
  steerHistory: [{ id: "steer-2", content: "Prefer Dublin and never expose token=secret-value" }, { id: "steer-1", content: "Keep the answer concise" }],
  businessRefs: [{ id: "artifact-1", kind: "artifact", ownerId: "user-1", hash: "hash-1" }, { id: "fact-1", kind: "job", ownerId: "user-1", resource: "persona_fact" }],
  toolObservations: [
    { id: "plan-revision:plan-1", content: { kind: "plan_revision", goalRevision: 2, planRevision: 1, sequence: "10" } },
    { id: "plan-result:plan-1:join", content: { kind: "plan_command", localId: "join", status: "completed", goalRevision: 2, planRevision: 1, sequence: "11" } },
    { id: "plan-control:plan-1:join:replan", content: { kind: "plan_control", localId: "join:replan", status: "replan_required", sequence: "12" } },
    { id: "wait-result:wait-1", content: { kind: "wait_result", status: "completed", sequence: "13" } },
    { id: "approval:approval-1", content: { kind: "approval", status: "pending", sequence: "14" } },
    { id: "evidence:read-1", content: { kind: "evidence", verified: true, sequence: "15" } },
    { id: "task:child-1", content: { kind: "task", status: "failed", taskId: "child-1", sequence: "16" } },
    { id: "event:event-1", content: { kind: "event", status: "recorded", sequence: "17" } },
    { id: "context-summary:old", content: { kind: "context_summary", value: { removedObservationIds: ["old-1", "old-3"] } } },
  ],
}

describe("context memory projection", () => {
  it("projects only server-classified public job evidence and marks it untrusted", () => {
    const snapshot: StepContextSnapshot = {
      ...base,
      businessRefs: [{ id: "job-1", kind: "job", ownerId: "user-1", resource: "job" }],
      toolObservations: [{ id: "tool-result:jobs-1", content: {
        toolCallId: "jobs-1", toolName: "jobs.search", status: "completed", errorCode: null,
        input: { target: "engineer" }, output: { jobs: [{ id: "job-1", company: "Example", role: "Engineer", location: "Dublin", status: "open", score: 9, url: "https://jobs.example/1", source: "greenhouse", salary: "€70k", description: "Public role description", keywords: "typescript" }], page: 1, hasMore: false },
      } }],
    }
    const projection = buildContextMemoryProjection(snapshot)
    expect(projection?.jobEvidenceExcerpts).toEqual([expect.objectContaining({ referenceId: "job-1", sourceRef: "tool-result:jobs-1", toolName: "jobs.search", trust: "external_untrusted", fields: { company: "Example", role: "Engineer", location: "Dublin", url: "https://jobs.example/1", source: "greenhouse", salary: "€70k", description: "Public role description" } })])
    expect(JSON.stringify(projection)).not.toContain("typescript")
  })

  it("sanitizes contact data from public job fields before projection", () => {
    const snapshot: StepContextSnapshot = {
      ...base,
      businessRefs: [{ id: "job-1", kind: "job", ownerId: "user-1", resource: "job" }],
      toolObservations: [{ id: "tool-result:jobs-contact", content: {
        toolCallId: "jobs-contact", toolName: "jobs.get", status: "completed", errorCode: null,
        output: { job: { id: "job-1", company: "Example recruiter@example.com", role: "Engineer", location: "Dublin", status: "open", score: 9, url: "https://jobs.example/1", source: "greenhouse", salary: "€70k", description: "Call +353 87 123 4567", keywords: null } },
      } }],
    }
    const projection = buildContextMemoryProjection(snapshot)
    expect(projection?.jobEvidenceExcerpts[0]?.fields).toMatchObject({ company: "Example [REDACTED_EMAIL]", description: "Call [REDACTED_PHONE]" })
    expect(JSON.stringify(projection)).not.toContain("recruiter@example.com")
    expect(JSON.stringify(projection)).not.toContain("+353 87 123 4567")
  })

  it("keeps repeated public job observations separately bound to their tool results", () => {
    const job = { id: "job-1", company: "Example", role: "Engineer", location: "Dublin", status: "open", score: 9, url: "https://jobs.example/1", source: "greenhouse", salary: "€70k", description: "Public role description", keywords: "typescript" }
    const snapshot: StepContextSnapshot = {
      ...base,
      businessRefs: [{ id: "job-1", kind: "job", ownerId: "user-1", resource: "job" }],
      toolObservations: [
        { id: "tool-result:jobs-1", content: { toolCallId: "jobs-1", toolName: "jobs.search", status: "completed", errorCode: null, output: { jobs: [job], page: 1, hasMore: false } } },
        { id: "tool-result:jobs-2", content: { toolCallId: "jobs-2", toolName: "jobs.get", status: "completed", errorCode: null, output: { job } } },
      ],
    }
    const excerpts = buildContextMemoryProjection(snapshot)?.jobEvidenceExcerpts
    expect(excerpts).toHaveLength(1)
    expect(excerpts?.[0]).toEqual(expect.objectContaining({ referenceId: "job-1", sourceRef: "tool-result:jobs-2" }))
  })

  it("fails closed for a foreign job or an unclassified evidence-looking observation", () => {
    const foreign: StepContextSnapshot = { ...base, businessRefs: [{ id: "job-1", kind: "job", ownerId: "user-1", resource: "job" }], toolObservations: [{ id: "evidence:foreign", content: { kind: "evidence", verified: true, output: { id: "job-1" } } }] }
    expect(buildContextMemoryProjection(foreign)?.jobEvidenceExcerpts).toEqual([])
    const malformed: StepContextSnapshot = { ...base, businessRefs: [{ id: "job-1", kind: "job", ownerId: "user-1", resource: "job" }], toolObservations: [{ id: "tool-result:jobs-1", content: { toolCallId: "jobs-1", toolName: "jobs.get", status: "completed", errorCode: null, output: { job: { id: "job-2", company: "Foreign", role: "Engineer", location: null, status: "open", score: null, url: null, source: "source", salary: null, description: null, keywords: null } } } }] }
    expect(buildContextMemoryProjection(malformed)?.jobEvidenceExcerpts).toEqual([])
    const mismatchedCall = { ...malformed, toolObservations: [{ ...malformed.toolObservations[0]!, id: "tool-result:other-call" }] }
    expect(buildContextMemoryProjection(mismatchedCall)?.jobEvidenceExcerpts).toEqual([])
  })

  it("projects typed anchors and durable evidence without raw text", () => {
    const projection = buildContextMemoryProjection(base)
    expect(projection).toMatchObject({
      schemaVersion: "agent-harness.cognitive-memory.v1",
      revisions: { goalRevision: 2, planRevision: null },
      activeGoals: [{ id: "goal-current", trust: "external_untrusted", summary: "Find a role" }],
      fixedConstraints: [{ id: "constraint-system", trust: "system" }],
      steering: [{ id: "steer-1" }, { id: "steer-2" }],
      waits: [{ id: "wait-result:wait-1", status: "completed", sequence: "13" }],
      approvals: [{ id: "approval:approval-1", status: "pending", sequence: "14" }],
      artifacts: [{ id: "artifact-1" }],
      verifiedEvidence: [{ id: "evidence:read-1" }, { id: "fact-1" }],
      taskRefs: [{ id: "task:child-1", status: "failed", sequence: "16" }],
      omittedRanges: [{ fromId: "old-1", toId: "old-3", reason: "compaction" }],
      coveredSequence: "17",
    })
    expect(JSON.stringify(projection)).not.toContain("secret-value")
  })

  it("sorts deterministically and remains stable across repeated compaction inputs", () => {
    const reversed = { ...base, steerHistory: [...base.steerHistory].reverse(), toolObservations: [...base.toolObservations].reverse() }
    expect(JSON.stringify(buildContextMemoryProjection(base))).toBe(JSON.stringify(buildContextMemoryProjection(reversed)))
  })

  it("validates and merges a prior projection deterministically within bounded input", () => {
    const prior = buildContextMemoryProjection(base)
    expect(prior).not.toBeNull()
    const current = { ...base, toolObservations: base.toolObservations.filter(item => item.id !== "context-summary:old") }
    const withPrior = { ...current, toolObservations: [{ id: "context-summary:prior", content: { kind: "context_summary", value: {}, memory: prior } }, ...current.toolObservations] }
    const first = buildContextMemoryProjection(withPrior)
    const second = buildContextMemoryProjection(withPrior)
    expect(first).not.toBeNull()
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(first?.decisions).toEqual([])
    expect(first?.unresolvedQuestions).toEqual([])
  })

  it("filters stale goal references from prior and current observations while retaining legacy references", () => {
    const old = buildContextMemoryProjection({
      ...base,
      toolObservations: [
        { id: "plan-revision:old", content: { kind: "plan_revision", goalRevision: 2, planRevision: 1, sequence: "20" } },
        { id: "wait-result:old", content: { kind: "wait_result", status: "pending", goalRevision: 2, planRevision: 1, sequence: "21" } },
        { id: "approval:old", content: { kind: "approval", status: "pending", goalRevision: 2, planRevision: 1, sequence: "22" } },
        { id: "event:old", content: { kind: "event", status: "recorded", goalRevision: 2, sequence: "23" } },
        { id: "wait-result:legacy", content: { kind: "wait_result", status: "pending", sequence: "24" } },
      ],
    })
    expect(old).not.toBeNull()
    const current = buildContextMemoryProjection({
      ...base,
      goal: { id: "goal-new", content: { revision: 3, objective: "New goal" } },
      toolObservations: [
        { id: "context-summary:old", content: { kind: "context_summary", value: {}, memory: old } },
        { id: "wait-result:old-direct", content: { kind: "wait_result", status: "pending", goalRevision: 2, sequence: "25" } },
        { id: "approval:old-direct", content: { kind: "approval", status: "pending", goalRevision: 2, sequence: "26" } },
        { id: "event:old-direct", content: { kind: "event", status: "recorded", goalRevision: 2, sequence: "27" } },
        { id: "wait-result:legacy-direct", content: { kind: "wait_result", status: "pending", sequence: "28" } },
        { id: "event:legacy-direct", content: { kind: "event", status: "recorded", sequence: "29" } },
      ],
    })
    expect(current?.waits.map(item => item.id)).toEqual(["wait-result:legacy", "wait-result:legacy-direct"])
    expect(current?.approvals).toEqual([])
    expect(current?.eventRefs.map(item => item.id)).toEqual(["event:legacy-direct", "wait-result:legacy", "wait-result:legacy-direct"])
    expect(current?.unresolved.map(item => item.id)).toEqual(["wait-result:legacy", "wait-result:legacy-direct"])
  })

  it("fails closed for a future goal reference", () => {
    const future = { ...base, toolObservations: [{ id: "event:future", content: { kind: "event", status: "recorded", goalRevision: 3 } }] }
    expect(buildContextMemoryProjection(future)).toBeNull()
  })

  it("trims low priority references to a requested byte budget", () => {
    const many: StepContextSnapshot = { ...base, toolObservations: Array.from({ length: 32 }, (_, index) => ({ id: `event:event-${index}`, content: { status: "recorded", sequence: String(index) } })) }
    const projection = buildContextMemoryProjection(many, { maxBytes: 900 })
    expect(projection).not.toBeNull()
    expect(projection!.eventRefs.length).toBeLessThan(32)
    expect(Buffer.byteLength(JSON.stringify(projection), "utf8")).toBeLessThanOrEqual(900)
  })

  it("fails closed for malformed, duplicate, or overbound snapshot input", () => {
    expect(buildContextMemoryProjection({ ...base, toolObservations: [...base.toolObservations, base.toolObservations[0]!] })).toBeNull()
    expect(buildContextMemoryProjection({ ...base, toolObservations: Array.from({ length: 257 }, (_, index) => ({ id: `event:${index}`, content: {} })) })).toBeNull()
    expect(buildContextMemoryProjection(base, { maxBytes: 255 })).toBeNull()
  })

  it("identifies wait, approval, and task anchors for adapter retention", () => {
    expect(base.toolObservations.filter(isContextMemoryAnchorObservation).map(item => item.id)).toEqual([
      "wait-result:wait-1", "approval:approval-1", "task:child-1", "event:event-1",
    ])
  })

  it.each(["agent.wait", "wait_subagents"] as const)("projects %s as a wait memory anchor", toolName => {
    const observation = { id: `tool-wait-${toolName}`, content: { toolName, status: "completed" } }
    const projection = buildContextMemoryProjection({ ...base, toolObservations: [observation] })

    expect(projection?.waits).toEqual([{ id: observation.id, status: "completed" }])
    expect(isContextMemoryAnchorObservation(observation)).toBe(true)
  })
})
