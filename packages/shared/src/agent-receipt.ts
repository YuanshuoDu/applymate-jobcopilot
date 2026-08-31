import { sha256Hex } from "@jobcopilot/agent-protocol"

export async function hashAgentReceiptValue(label: string, value: unknown): Promise<string> {
  return sha256Hex(`applymate.legacy-receipt.${label}.v1:${stableJson(value)}`)
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`
}
