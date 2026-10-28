import { describe, expect, it } from "vitest"
import type { HarnessModelRequest } from "@jobcopilot/agent-model"
import type { StepContextSnapshot } from "../context/step-context-builder.js"
import { buildFinalAnswerEvidenceBindingMap } from "./final-answer-evidence.js"
import type { FinalAnswerEvidenceScope } from "./final-answer-evidence-json.js"
import { stableAnswerEvidenceJson } from "./final-answer-evidence-json.js"
import { prepareTurnFinalAnswerEvidenceRequest, resolveTurnFinalAnswerMarkers, restoreTurnFinalAnswerEvidence } from "./turn-execution-evidence.js"

const job = { id: "private-job", company: "Acme", role: "Engineer", location: "Dublin", status: "saved", score: 8,
  url: null, source: "manual", salary: null, description: null, keywords: null }
const output = { jobs: [job], page: 1, hasMore: false }
const input = { location: "Dublin" }
const snapshot: StepContextSnapshot = { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [{ id: "tool-result:call-a",
  content: { toolCallId: "call-a", toolName: "jobs.search", input, status: "completed", output, errorCode: null } }] }

function scope(turnId: string, stepId = "step-final"): FinalAnswerEvidenceScope {
  return { userId: "user-1", sessionId: "session-1", turnId, taskId: "root-1", stepId }
}
function request(value: FinalAnswerEvidenceScope): HarnessModelRequest {
  return { metadata: value, messages: [
    { role: "assistant", content: [{ type: "tool_use", id: "call-a", name: "jobs.search", input }] },
    { role: "tool", content: [{ type: "tool_result", toolUseId: "call-a", content: stableAnswerEvidenceJson(output) }] },
  ] } as unknown as HarnessModelRequest
}

describe("Turn final answer evidence request binding", () => {
  it("adds the safe key instruction to the exact request and removes forged S markers", () => {
    const original = request(scope("turn-1")), prepared = prepareTurnFinalAnswerEvidenceRequest(original, snapshot, scope("turn-1"))
    const key = prepared.bindingMap?.bindings[0]?.key
    expect(key).toMatch(/^E-[a-f0-9]{64}$/)
    expect(prepared.request.messages).not.toBe(original.messages)
    expect(prepared.request.messages.some(message => message.role === "system"
      && message.content.some(part => part.type === "text" && part.text.includes(`${key} -> tool=jobs.search record=jobs/0`)))).toBe(true)
    expect(prepared.bindingMap?.promptInstruction).not.toMatch(/call-a|private-job|Acme/)
    expect(resolveTurnFinalAnswerMarkers(`Acme role [[source:${key}]][[source:S2]]`, prepared.bindingMap))
      .toMatchObject({ text: "Acme role [[source:S1]]", answerEvidence: { sources: [{ key: "S1", label: "Job listing" }] } })
  })

  it("scopes repeated tool IDs and identical observations to one Turn and original step", () => {
    const first = buildFinalAnswerEvidenceBindingMap(request(scope("turn-1")), snapshot, scope("turn-1"))
    const second = buildFinalAnswerEvidenceBindingMap(request(scope("turn-2")), snapshot, scope("turn-2"))
    expect(first?.bindings[0]?.key).not.toBe(second?.bindings[0]?.key)
    expect(restoreTurnFinalAnswerEvidence(snapshot, first?.sourceReceipt, scope("turn-2"))).toBeNull()
    expect(restoreTurnFinalAnswerEvidence(snapshot, first?.sourceReceipt, scope("turn-1", "recovery-step"))).toBeNull()
    expect(resolveTurnFinalAnswerMarkers("Claim [[source:S1]] [[source:E-0000000000000000000000000000000000000000000000000000000000000000]]", null))
      .toEqual({ text: "Claim  " })
  })

  it("refuses to bind a request whose own metadata does not match the explicit scope", () => {
    const prepared = prepareTurnFinalAnswerEvidenceRequest(request(scope("turn-1")), snapshot, scope("turn-2"))
    expect(prepared.bindingMap).toBeNull()
    expect(prepared.request).toBeDefined()
  })

  it("accepts the persisted Step ID shape used by scheduled candidates", () => {
    const scheduledScope = scope("turn-1", "step:1")
    expect(buildFinalAnswerEvidenceBindingMap(request(scheduledScope), snapshot, scheduledScope)).not.toBeNull()
  })
})
