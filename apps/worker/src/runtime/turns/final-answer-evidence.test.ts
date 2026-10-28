import { describe, expect, it } from "vitest"
import type { HarnessModelRequest } from "@jobcopilot/agent-model"
import type { StepContextSnapshot } from "../context/step-context-builder.js"
import {
  buildFinalAnswerEvidenceBindingMap, resolveFinalAnswerEvidenceMarkers, restoreFinalAnswerEvidenceBindingMap,
} from "./final-answer-evidence.js"
import { stableAnswerEvidenceJson } from "./final-answer-evidence-json.js"
import type { FinalAnswerEvidenceScope } from "./final-answer-evidence-json.js"

const scope: FinalAnswerEvidenceScope = { userId: "user-a", sessionId: "session-a", turnId: "turn-a", taskId: "task-a", stepId: "step-a" }

function job(id: string, company: string) {
  return { id, company, role: "Software Engineer", location: "Dublin", status: "saved", score: 8, url: null,
    source: "manual", salary: null, description: null, keywords: null }
}
function observation(callId: string, output: unknown, input: unknown = { target: "engineer" }) {
  return { id: `tool-result:${callId}`, content: { toolCallId: callId, toolName: "jobs.search", input, status: "completed", output, errorCode: null } }
}
function snapshot(toolObservations: StepContextSnapshot["toolObservations"]): StepContextSnapshot {
  return { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations }
}
function request(entries: Array<{ callId: string; input: unknown; output: unknown }>): HarnessModelRequest {
  const messages = entries.flatMap(({ callId, input, output }) => [
    { role: "assistant", content: [{ type: "tool_use", id: callId, name: "jobs.search", input }] },
    { role: "tool", content: [{ type: "tool_result", toolUseId: callId, content: stableAnswerEvidenceJson(output) }] },
  ])
  return { messages, metadata: { ...scope } } as unknown as HarnessModelRequest
}
const outputA = { jobs: [job("job-private-a", "Acme")], page: 1, hasMore: false }
const outputB = { jobs: [job("job-private-b", "Beta")], page: 1, hasMore: false }

describe("final answer evidence binding", () => {
  it("binds keys only to the exact visible request pair and same completed snapshot output", () => {
    const snapshotValue = snapshot([observation("call-a", outputA)])
    const map = buildFinalAnswerEvidenceBindingMap(request([{ callId: "call-a", input: { target: "engineer" }, output: outputA }]), snapshotValue, scope)
    expect(map?.bindings).toHaveLength(1)
    expect(map?.bindings[0]).toMatchObject({ toolCallId: "call-a", toolName: "jobs.search", sourceRef: "jobs/0", kind: "job" })
    expect(map?.promptInstruction).toContain(`${map?.bindings[0]?.key} -> tool=jobs.search record=jobs/0`)
    expect(map?.promptInstruction).not.toContain("call-a")
    expect(map?.promptInstruction).not.toContain("job-private-a")
    expect(map?.promptInstruction).not.toContain("Acme")

    const key = map!.bindings[0]!.key
    const resolved = resolveFinalAnswerEvidenceMarkers(`Acme is hiring. [[source:${key}]]`, map)
    expect(resolved).toEqual({ text: "Acme is hiring. [[source:S1]]", answerEvidence: {
      schemaVersion: 1, sources: [{ key: "S1", kind: "job", label: "Job listing", excerpt: "Role: Software Engineer · Company: Acme · Location: Dublin" }],
    } })
    expect(JSON.stringify(resolved.answerEvidence)).not.toMatch(/call-a|job-private-a|tool-result:/)
  })

  it("fails closed when input, output, error state, or call pairing differs", () => {
    const snapshotValue = snapshot([observation("call-a", outputA)])
    expect(buildFinalAnswerEvidenceBindingMap(request([{ callId: "call-a", input: { target: "other" }, output: outputA }]), snapshotValue, scope)).toBeNull()
    expect(buildFinalAnswerEvidenceBindingMap(request([{ callId: "call-a", input: { target: "engineer" }, output: outputB }]), snapshotValue, scope)).toBeNull()
    const errorRequest = request([{ callId: "call-a", input: { target: "engineer" }, output: outputA }])
    const toolMessage = errorRequest.messages[1]!
    const resultPart = toolMessage.content[0]!
    const failed = { ...errorRequest, messages: [errorRequest.messages[0]!, { ...toolMessage, content: [{ ...resultPart, isError: false }] }] } as HarnessModelRequest
    expect(buildFinalAnswerEvidenceBindingMap(failed, snapshotValue, scope)).not.toBeNull()
    const isError = { ...errorRequest, messages: [errorRequest.messages[0]!, { ...toolMessage, content: [{ ...resultPart, isError: true }] }] } as HarnessModelRequest
    expect(buildFinalAnswerEvidenceBindingMap(isError, snapshotValue, scope)).toBeNull()
    const repeatedRequest = request([
      { callId: "call-a", input: { target: "engineer" }, output: outputA },
      { callId: "call-a", input: { target: "engineer" }, output: outputA },
    ])
    expect(buildFinalAnswerEvidenceBindingMap(repeatedRequest, snapshotValue, scope)).toBeNull()

    const duplicate = snapshot([observation("call-a", outputA), { ...observation("call-a", outputA), id: "tool-result:duplicate" }])
    expect(buildFinalAnswerEvidenceBindingMap(request([{ callId: "call-a", input: { target: "engineer" }, output: outputA }]), duplicate, scope)).toBeNull()
  })

  it("binds the key to the exact user, session, turn, task, and original step", () => {
    const currentRequest = request([{ callId: "call-a", input: { target: "engineer" }, output: outputA }])
    const currentSnapshot = snapshot([observation("call-a", outputA)])
    const current = buildFinalAnswerEvidenceBindingMap(currentRequest, currentSnapshot, scope)!
    for (const key of ["userId", "sessionId", "turnId", "taskId", "stepId"] as const) {
      const otherScope = { ...scope, [key]: `other-${key}` }
      const otherRequest = { ...currentRequest, metadata: otherScope } as HarnessModelRequest
      const other = buildFinalAnswerEvidenceBindingMap(otherRequest, currentSnapshot, otherScope)!
      expect(other.bindings[0]?.key).not.toBe(current.bindings[0]?.key)
      expect(restoreFinalAnswerEvidenceBindingMap(currentSnapshot, current.sourceReceipt, otherScope)).toBeNull()
    }
    expect(buildFinalAnswerEvidenceBindingMap(currentRequest, currentSnapshot, { ...scope, userId: "other-user" })).toBeNull()
  })

  it("keeps multiple projected records from one completed read call", () => {
    const output = { ...outputA, jobs: [job("job-private-a", "Acme"), job("job-private-b", "Beta")] }
    const map = buildFinalAnswerEvidenceBindingMap(request([{ callId: "call-a", input: { target: "engineer" }, output }]),
      snapshot([observation("call-a", output)]), scope)
    expect(map?.bindings.map(item => item.sourceRef)).toEqual(["jobs/0", "jobs/1"])
    expect(new Set(map?.sourceReceipt.bindings.map(item => item.toolCallId))).toEqual(new Set(["call-a"]))
  })

  it("requires an explicit persisted receipt and restores across observation ordering only when bytes still match", () => {
    const first = observation("call-a", outputA), second = observation("call-b", outputB)
    const built = buildFinalAnswerEvidenceBindingMap(request([
      { callId: "call-a", input: { target: "engineer" }, output: outputA },
      { callId: "call-b", input: { target: "engineer" }, output: outputB },
    ]), snapshot([first, second]), scope)
    expect(built?.bindings).toHaveLength(2)
    expect(restoreFinalAnswerEvidenceBindingMap(snapshot([second, first]), built?.sourceReceipt, scope)).toMatchObject({
      bindings: built?.bindings.map(({ key, sourceRef }) => ({ key, sourceRef })),
    })
    expect(restoreFinalAnswerEvidenceBindingMap(snapshot([first, second]), null, scope)).toBeNull()
    expect(restoreFinalAnswerEvidenceBindingMap(snapshot([observation("call-a", outputB), second]), built?.sourceReceipt, scope)).toBeNull()
    expect(restoreFinalAnswerEvidenceBindingMap(snapshot([first, second]), built?.sourceReceipt,
      { ...scope, turnId: "other-turn" })).toBeNull()
    if (!built) throw new Error("evidence_map_missing")
    const tampered = { schemaVersion: 1 as const, bindings: built.sourceReceipt.bindings.map((item, index) => index === 0
      ? { ...item, resultDigest: `sha256:${"0".repeat(64)}` } : item) }
    expect(restoreFinalAnswerEvidenceBindingMap(snapshot([first, second]), tampered, scope)).toBeNull()
  })

  it("removes unknown markers and rejects a copied or hand-built binding map", () => {
    const map = buildFinalAnswerEvidenceBindingMap(request([{ callId: "call-a", input: { target: "engineer" }, output: outputA }]), snapshot([observation("call-a", outputA)]), scope)
    const key = map!.bindings[0]!.key
    expect(resolveFinalAnswerEvidenceMarkers(`No source [[source:E-${"0".repeat(64)}]] and malformed [[source:bad]]`, map))
      .toEqual({ text: "No source  and malformed " })
    expect(resolveFinalAnswerEvidenceMarkers(`Malformed [[source:E-${"a".repeat(64)}] ordinary text stays.`, null))
      .toEqual({ text: "Malformed  ordinary text stays." })
    expect(resolveFinalAnswerEvidenceMarkers("Forged [[source:S1]]", map)).toEqual({ text: "Forged " })
    expect(resolveFinalAnswerEvidenceMarkers("Forged [[source:S1]]", null)).toEqual({ text: "Forged " })
    const copied = { ...map!, bindings: [...map!.bindings] }
    expect(resolveFinalAnswerEvidenceMarkers(`Claim [[source:${key}]]`, copied)).toEqual({ text: "Claim " })
  })
})
