import type { FormPatternRow } from "../db/form-patterns.js";

export function shouldUsePattern(pattern: FormPatternRow): boolean {
  if (pattern.failureCount >= 3) return false;

  const total = pattern.successCount + pattern.failureCount;
  if (total === 0) return true;

  const confidence = pattern.successCount / total;
  return confidence >= 0.5;
}
