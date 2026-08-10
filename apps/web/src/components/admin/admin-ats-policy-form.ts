export type AtsPolicyFormValue = {
  rolloutPercent: number
  globalRpsLimit: number
  perTenantRpsLimit: number
  maxRetries: number
  backoffBaseMs: number
  allowAutoApply: boolean
  version: number
}

export function toAtsPolicyPayload<T extends AtsPolicyFormValue>(value: T): AtsPolicyFormValue {
  return {
    rolloutPercent: value.rolloutPercent,
    globalRpsLimit: value.globalRpsLimit,
    perTenantRpsLimit: value.perTenantRpsLimit,
    maxRetries: value.maxRetries,
    backoffBaseMs: value.backoffBaseMs,
    allowAutoApply: value.allowAutoApply,
    version: value.version,
  }
}
