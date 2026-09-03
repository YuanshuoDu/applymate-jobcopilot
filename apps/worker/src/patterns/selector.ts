import type { AtsSourceKey } from "@jobcopilot/shared/ats-url";
import type { FormPatternRow } from "../db/form-patterns.js";
import { shouldUsePattern } from "./confidence.js";

export type FillStrategy =
  | { readonly kind: "deterministic"; readonly atsType: AtsSourceKey }
  | { readonly kind: "pattern"; readonly pattern: FormPatternRow }
  | { readonly kind: "ai"; readonly reason: "unknown_ats" | "pattern_miss" }
  | { readonly kind: "budget"; readonly reason: "ai_budget_exhausted" };

/** Select one fill path. Selection never authorizes an external write. */
export function selectFillStrategy(input: {
  readonly atsType?: AtsSourceKey | null;
  readonly pattern?: FormPatternRow | null;
  readonly aiAvailable?: boolean;
}): FillStrategy {
  if (input.atsType) return { kind: "deterministic", atsType: input.atsType };
  if (input.pattern && shouldUsePattern(input.pattern)) return { kind: "pattern", pattern: input.pattern };
  if (input.aiAvailable === false) return { kind: "budget", reason: "ai_budget_exhausted" };
  return { kind: "ai", reason: input.pattern ? "pattern_miss" : "unknown_ats" };
}
