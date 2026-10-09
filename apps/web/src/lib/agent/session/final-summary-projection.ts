import { redactSensitiveText } from "@jobcopilot/shared/agent-redaction"

const MAX_FINAL_SUMMARY_LENGTH = 1_000

export function projectFinalSummary(
  type: unknown,
  phase: unknown,
  status: unknown,
  content: unknown,
): string | undefined {
  if (type !== "agent_message" || phase !== "final_answer" || status !== "completed") return undefined
  const itemContent = record(content)
  if (!itemContent) return undefined

  const source = Object.hasOwn(itemContent, "final")
    ? record(ownValue(itemContent, "final"))
    : itemContent
  if (!source) return undefined
  const summary = ownValue(source, "summary")
  if (typeof summary !== "string" || summary.trim().length === 0 || summary.length > MAX_FINAL_SUMMARY_LENGTH) return undefined
  const safeSummary = redactSensitiveText(summary)
  return safeSummary.length <= MAX_FINAL_SUMMARY_LENGTH ? safeSummary : undefined
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}

function ownValue(value: Record<string, unknown>, key: string): unknown {
  const property = Object.getOwnPropertyDescriptor(value, key)
  return property && "value" in property ? property.value : undefined
}
