import type { HarnessModelRequest } from "@jobcopilot/agent-model"
import type { StepContextSnapshot } from "../context/step-context-builder.js"
import type { FinalAnswerEvidenceScope } from "./final-answer-evidence-json.js"
import {
  buildFinalAnswerEvidenceBindingMap, resolveFinalAnswerEvidenceMarkers, restoreFinalAnswerEvidenceBindingMap,
  type FinalAnswerEvidenceBindingMap,
} from "./final-answer-evidence.js"

export function prepareTurnFinalAnswerEvidenceRequest(request: HarnessModelRequest, snapshot: StepContextSnapshot, scope: FinalAnswerEvidenceScope): {
  request: HarnessModelRequest
  bindingMap: FinalAnswerEvidenceBindingMap | null
} {
  const bindingMap = buildFinalAnswerEvidenceBindingMap(request, snapshot, scope)
  if (!bindingMap) return { request, bindingMap: null }
  const messages = [...request.messages], firstNonSystem = messages.findIndex(message => message.role !== "system")
  const instruction: HarnessModelRequest["messages"][number] = { role: "system", content: [{ type: "text", text: bindingMap.promptInstruction }] }
  messages.splice(firstNonSystem < 0 ? messages.length : firstNonSystem, 0, instruction)
  return { request: { ...request, messages }, bindingMap }
}

export function restoreTurnFinalAnswerEvidence(snapshot: StepContextSnapshot, receipt: unknown, scope: FinalAnswerEvidenceScope): FinalAnswerEvidenceBindingMap | null {
  return restoreFinalAnswerEvidenceBindingMap(snapshot, receipt, scope)
}

export function resolveTurnFinalAnswerMarkers(text: string, bindingMap: FinalAnswerEvidenceBindingMap | null) {
  return resolveFinalAnswerEvidenceMarkers(text.replace(/\[\[source:S[1-8]\]\]/g, ""), bindingMap)
}
