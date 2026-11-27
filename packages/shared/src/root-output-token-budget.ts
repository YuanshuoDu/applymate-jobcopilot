export const ROOT_OUTPUT_TOKEN_BUDGET_ENV = "AGENT_ROOT_MAX_OUTPUT_TOKENS"
const MAX_OUTPUT_TOKEN_BUDGET = 2_147_483_647

export type RootOutputTokenBudgetSnapshot = { limits: { maxOutputTokens: number } } | Record<string, never>

export class RootOutputTokenBudgetConfigurationError extends Error {
  readonly code = "root_output_token_budget_configuration_invalid"

  constructor() {
    super("AGENT_ROOT_MAX_OUTPUT_TOKENS must be a non-negative integer no greater than 2147483647")
    this.name = "RootOutputTokenBudgetConfigurationError"
  }
}

/** Pure parser shared by Web and Worker; callers own when and where server configuration is read. */
export function parseRootOutputTokenBudget(value: string | undefined): RootOutputTokenBudgetSnapshot {
  if (value === undefined) return {}
  if (!/^\d+$/.test(value)) throw new RootOutputTokenBudgetConfigurationError()
  const maxOutputTokens = Number(value)
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens > MAX_OUTPUT_TOKEN_BUDGET) {
    throw new RootOutputTokenBudgetConfigurationError()
  }
  return { limits: { maxOutputTokens } }
}
