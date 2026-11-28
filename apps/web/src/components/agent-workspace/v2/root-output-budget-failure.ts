const ROOT_OUTPUT_BUDGET_FAILURES = {
  root_output_budget_configured_zero_limit: {
    en: "This Turn stopped before model output because its configured output limit is zero. No automatic retry was made.",
    zh: "本轮在请求模型输出前停止：当前配置的输出额度为零。本轮没有自动重试。",
  },
  root_output_budget_settled_exhausted: {
    en: "This Turn stopped before model output because settled usage leaves no output allowance for this Root Turn. No automatic retry was made.",
    zh: "本轮在请求模型输出前停止：已结算用量已耗尽本 Root Turn 的输出额度。本轮没有自动重试。",
  },
  root_output_budget_active_reservation_hold: {
    en: "This Turn stopped before model output because an existing usage reservation holds the remaining allowance. It was not automatically replayed. Check the reservation status before starting another attempt.",
    zh: "本轮在请求模型输出前停止：现有用量预留占用了剩余额度。本轮没有自动重放；再次尝试前请先核对预留状态。",
  },
} as const

export type RootOutputBudgetFailureCode = keyof typeof ROOT_OUTPUT_BUDGET_FAILURES

/** Render only the closed Root failure codes; all other reasons keep their existing projection. */
export function rootOutputBudgetFailureText(reason: unknown, lang: string): string | undefined {
  if (typeof reason !== "string" || !Object.hasOwn(ROOT_OUTPUT_BUDGET_FAILURES, reason)) return undefined
  const copy = ROOT_OUTPUT_BUDGET_FAILURES[reason as RootOutputBudgetFailureCode]
  return lang === "zh" ? copy.zh : copy.en
}
