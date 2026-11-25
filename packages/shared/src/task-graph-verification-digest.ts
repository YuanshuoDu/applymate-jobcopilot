import { createHash } from "node:crypto"

type Row = Record<string, unknown>
type ReplayReceipt = Readonly<{
  currentCallId: string
  sourceCallItem: readonly [string, number]
  sourceResultItem: readonly [string, number]
}>

// Keep this allowlist shared with receipt projection so Web and Worker hash the same evidence.
const EVIDENCE_TOOLS = new Set([
  "jobs.search", "jobs.get", "jobs.discover", "tool_results.read", "persona.retrieve", "resume.get_base",
])

export function isTaskGraphEvidenceToolName(value: unknown): value is string {
  return typeof value === "string" && EVIDENCE_TOOLS.has(value)
}

export function taskGraphResultDigest(value: unknown): string {
  return createHash("sha256").update(canonicalTaskGraphResultJson(value)).digest("hex")
}

export function taskGraphEvidenceDigest(
  items: readonly Row[],
  outcomes: ReadonlyMap<string, "completed" | "failed">,
  evidenceIds: readonly string[],
  resultDigest: string,
  replayReceipts: readonly ReplayReceipt[],
): string {
  const byCall = new Map(items.filter(item => item.type === "tool_result")
    .map(item => [String((item.content as Row).toolCallId), item] as const))
  const replayByCall = new Map(replayReceipts.map(receipt => [receipt.currentCallId, receipt] as const))
  const receipts = items.filter(item => item.type === "tool_call"
    && isTaskGraphEvidenceToolName(String((item.content as Row).toolName))
    && outcomes.get(String((item.content as Row).toolCallId)) === "completed").map(call => {
      const content = call.content as Row
      const result = byCall.get(String(content.toolCallId))!
      const output = JSON.stringify((result.content as Row).output)
      return {
        attempt: Number(call.attempt), callId: content.toolCallId, toolName: content.toolName,
        toolVersion: content.toolVersion, callItem: [call.id, Number(call.revision)],
        resultItem: [result.id, Number(result.revision)],
        replaySource: replayByCall.get(String(content.toolCallId)) ?? null,
        outputHash: createHash("sha256").update(output).digest("hex"),
      }
    }).sort((a, b) => a.attempt - b.attempt || String(a.callId).localeCompare(String(b.callId)))
  return createHash("sha256").update(JSON.stringify({
    evidenceIds: [...evidenceIds].sort(), receipts, resultDigest,
  })).digest("hex")
}

export function canonicalTaskGraphResultJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalTaskGraphResultJson).join(",")}]`
  const row = record(value)
  if (row) return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalTaskGraphResultJson(row[key])}`).join(",")}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error("task_graph_verification_result_invalid")
  return encoded
}

function record(value: unknown): Row | undefined {
  const parsed = typeof value === "string" ? (() => {
    try { return JSON.parse(value) as unknown } catch { return undefined }
  })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  try {
    const prototype = Object.getPrototypeOf(parsed)
    return prototype === Object.prototype || prototype === null ? parsed as Row : undefined
  } catch {
    return undefined
  }
}
