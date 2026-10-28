import { describe, expect, it } from "vitest"
import type { HarnessModelRequest } from "@jobcopilot/agent-model"
import type { StepContextSnapshot } from "../context/step-context-builder.js"
import type { ModelStepResult } from "./turn-engine-model.js"
import { buildFinalAnswerEvidenceBindingMap } from "./final-answer-evidence.js"
import type { FinalAnswerEvidenceScope } from "./final-answer-evidence-json.js"
import { stableAnswerEvidenceJson } from "./final-answer-evidence-json.js"
import { restoreTurnFinalAnswerEvidence } from "./turn-execution-evidence.js"
import { resolveTurnExecutionFinalAnswer } from "./turn-execution-final-answer.js"

const scope: FinalAnswerEvidenceScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", stepId: "step-final" }
const job = { id: "c123456789012345678901234", company: "Acme", role: "Engineer", location: "Dublin",
  status: "saved", score: 8, url: null, source: "manual", salary: null, description: "Contact [REDACTED_EMAIL]", keywords: null }
const output = { jobs: [job], page: 1, hasMore: false }
const input = { location: "Dublin" }
const snapshot: StepContextSnapshot = { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [{ id: "tool-result:call-a",
  content: { toolCallId: "call-a", toolName: "jobs.search", input, status: "completed", output, errorCode: null } }] }
const request = { metadata: scope, messages: [
  { role: "assistant", content: [{ type: "tool_use", id: "call-a", name: "jobs.search", input }] },
  { role: "tool", content: [{ type: "tool_result", toolUseId: "call-a", content: stableAnswerEvidenceJson(output) }] },
] } as unknown as HarnessModelRequest

function modelOutput(text: string): ModelStepResult {
  return { text, reasoningSummary: "", toolCalls: [], provider: "fixture", model: "fixture", finishReason: "stop", usage: null, continuation: null }
}

describe("turn execution final answer", () => {
  it("keeps raw candidate text while resolving only keys bound to the request", () => {
    const map = buildFinalAnswerEvidenceBindingMap(request, snapshot, scope)
    const key = map?.bindings[0]?.key
    expect(key).toMatch(/^E-[a-f0-9]{64}$/)
    const rawOutput = modelOutput(`Acme has a Dublin role [[source:${key}]][[source:S2]].`)

    const resolved = resolveTurnExecutionFinalAnswer(rawOutput, map)

    expect(resolved.output).toBe(rawOutput)
    expect(resolved.output.text).toBe(`Acme has a Dublin role [[source:${key}]][[source:S2]].`)
    expect(resolved.finalResponseText).toBe("Acme has a Dublin role [[source:S1]].")
    expect(resolved.answerEvidence).toMatchObject({ sources: [{ key: "S1", label: "Job listing" }] })
  })

  it("restores a scheduled receipt only for its original scope and strips citations otherwise", () => {
    const map = buildFinalAnswerEvidenceBindingMap(request, snapshot, scope)
    const key = map?.bindings[0]?.key
    expect(key).toMatch(/^E-[a-f0-9]{64}$/)
    const restored = restoreTurnFinalAnswerEvidence(snapshot, map?.sourceReceipt, scope)
    const rawOutput = modelOutput(`Saved role [[source:${key}]].`)
    const answer = resolveTurnExecutionFinalAnswer(rawOutput, restored)
    const wrongScope = restoreTurnFinalAnswerEvidence(snapshot, map?.sourceReceipt, { ...scope, stepId: "recovery-step" })

    expect(answer.finalResponseText).toBe("Saved role [[source:S1]].")
    expect(answer.answerEvidence).toBeDefined()
    expect(wrongScope).toBeNull()
    expect(resolveTurnExecutionFinalAnswer(modelOutput("Legacy [[source:S1]] [[source:E-" + "a".repeat(64) + "]]."), wrongScope))
      .toMatchObject({ finalResponseText: "Legacy  ." })
  })
})
