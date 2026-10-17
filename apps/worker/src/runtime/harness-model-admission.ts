import type { HarnessModelRequest, ModelAdapter } from "@jobcopilot/agent-model"
import {
  ContextEstimateExceededError,
  estimateModelRequestAdmission,
} from "./turns/model-request-admission.js"

export type HarnessRequestAdmissionDiagnostic = Readonly<{
  provider: string
  model: string
  status: "known" | "unknown"
  method: string
  estimateVersion: number
  estimatedInputTokens?: number
  outputReserveTokens?: number
  contextWindowTokens?: number
  withinWindow?: boolean
}>

export function preflightHarnessModelRequest(
  request: HarnessModelRequest,
  profile: ModelAdapter["profile"],
  options: {
    guaranteedNoProviderAttempt: boolean
    onRequestAdmission?:
      | ((diagnostic: HarnessRequestAdmissionDiagnostic) => void)
      | ((diagnostic: HarnessRequestAdmissionDiagnostic) => PromiseLike<void>)
  },
) {
  const estimate = estimateModelRequestAdmission(request, profile)
  const diagnostic: HarnessRequestAdmissionDiagnostic = estimate.status === "known"
    ? { provider: profile.provider, model: profile.model, status: "known", method: estimate.method,
      estimateVersion: estimate.estimateVersion, estimatedInputTokens: estimate.estimatedInputTokens,
      outputReserveTokens: estimate.outputReserveTokens, contextWindowTokens: estimate.contextWindowTokens,
      withinWindow: estimate.withinWindow }
    : { provider: profile.provider, model: profile.model, status: "unknown", method: "unknown",
      estimateVersion: estimate.estimateVersion }
  try {
    const result = options.onRequestAdmission?.(diagnostic)
    void Promise.resolve(result).catch(() => undefined)
  } catch { /* Diagnostics cannot change routing. */ }
  if (estimate.status === "known" && !estimate.withinWindow) {
    throw new ContextEstimateExceededError({
      provider: profile.provider, model: profile.model,
      guaranteedNoProviderAttempt: options.guaranteedNoProviderAttempt,
    })
  }
  return estimate
}
