type Row = Record<string, unknown>

function taskGraphSnapshotObject(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const prototype = Object.getPrototypeOf(parsed)
  return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(parsed).length === 0
    ? parsed as Row
    : null
}

/** Matches the Worker TaskGraph snapshot codec, including JSON-object strings. */
export function canonicalTaskGraphReceiptJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalTaskGraphReceiptJson).join(",")}]`
  const row = taskGraphSnapshotObject(value)
  if (row) return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalTaskGraphReceiptJson(row[key])}`).join(",")}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new TypeError("task_graph_json_invalid")
  return encoded
}
