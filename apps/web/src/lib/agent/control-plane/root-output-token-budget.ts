import type { Prisma } from "@prisma/client"
import {
  parseRootOutputTokenBudget,
  ROOT_OUTPUT_TOKEN_BUDGET_ENV,
  RootOutputTokenBudgetConfigurationError,
} from "@jobcopilot/shared/root-output-token-budget"

export { parseRootOutputTokenBudget, ROOT_OUTPUT_TOKEN_BUDGET_ENV, RootOutputTokenBudgetConfigurationError }

export class RootBudgetSnapshotInvalidError extends Error {
  readonly code = "root_budget_snapshot_invalid"

  constructor() {
    super("A persisted Root budget snapshot must be a JSON object")
    this.name = "RootBudgetSnapshotInvalidError"
  }
}

/** Read only at new-Turn admission; callers never accept a client or model override. */
export function readRootOutputTokenBudgetSnapshot(): Prisma.InputJsonValue {
  return parseRootOutputTokenBudget(process.env[ROOT_OUTPUT_TOKEN_BUDGET_ENV]) as Prisma.InputJsonValue
}

/** Retries retain the predecessor's whole persisted budget instead of adopting new config. */
export function requirePersistedRootBudgetSnapshot(value: unknown): Prisma.InputJsonValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RootBudgetSnapshotInvalidError()
  }
  return value as Prisma.InputJsonValue
}
