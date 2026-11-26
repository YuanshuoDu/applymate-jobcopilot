export const OBJECTIVE_SOURCE_TOOL_RECEIPT_SCHEMA = 'agent-harness.v2.objective-tool-receipt-evidence.v1' as const
export const OBJECTIVE_SOURCE_TOOL_RECEIPT_TOOLS = ['jobs.discover', 'jobs.search', 'jobs.get', 'tool_results.read'] as const
export const OBJECTIVE_SOURCE_TOOL_RECEIPT_DELIVERIES = ['fresh', 'replayed'] as const
export const OBJECTIVE_SOURCE_TOOL_RECEIPT_MAX_GRAPH_REVISION = 1_000_000 as const

export type ObjectiveSourceToolReceiptTool = typeof OBJECTIVE_SOURCE_TOOL_RECEIPT_TOOLS[number]
export type ObjectiveSourceToolReceiptDelivery = typeof OBJECTIVE_SOURCE_TOOL_RECEIPT_DELIVERIES[number]
export type ObjectiveSourceToolReceiptRole = 'scout' | 'analyst'
export type ObjectiveSourceToolReceipt = Readonly<{
  ordinal: number
  receiptKey: string
  toolName: ObjectiveSourceToolReceiptTool
  delivery: ObjectiveSourceToolReceiptDelivery
}>
export type ObjectiveSourceToolReceiptEvidence = Readonly<{
  schemaVersion: typeof OBJECTIVE_SOURCE_TOOL_RECEIPT_SCHEMA
  graphRevision: number
  sourceKey: string
  role: ObjectiveSourceToolReceiptRole
  receipts: readonly ObjectiveSourceToolReceipt[]
}>

/** Parses the deliberately opaque browser projection; receipt identity stays server-only. */
export function parseObjectiveSourceToolReceiptEvidence(value: unknown): ObjectiveSourceToolReceiptEvidence | undefined {
  const row = record(value)
  if (!row || !exact(row, 'graphRevision,receipts,role,schemaVersion,sourceKey')
    || row.schemaVersion !== OBJECTIVE_SOURCE_TOOL_RECEIPT_SCHEMA || !positive(row.graphRevision)
    || !sourceKey(row.sourceKey) || !(row.role === 'scout' || row.role === 'analyst')) return undefined
  const receipts = dense(row.receipts, 64)
  if (!receipts || receipts.length < 1) return undefined
  const parsed: ObjectiveSourceToolReceipt[] = []
  const seen = new Set<string>()
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = record(receipts[index])
    if (!receipt || !exact(receipt, 'delivery,ordinal,receiptKey,toolName') || receipt.ordinal !== index + 1
      || !receiptKey(receipt.receiptKey) || seen.has(receipt.receiptKey)
      || !OBJECTIVE_SOURCE_TOOL_RECEIPT_TOOLS.includes(receipt.toolName as ObjectiveSourceToolReceiptTool)
      || !OBJECTIVE_SOURCE_TOOL_RECEIPT_DELIVERIES.includes(receipt.delivery as ObjectiveSourceToolReceiptDelivery)) return undefined
    seen.add(receipt.receiptKey)
    parsed.push({ ordinal: index + 1, receiptKey: receipt.receiptKey,
      toolName: receipt.toolName as ObjectiveSourceToolReceiptTool,
      delivery: receipt.delivery as ObjectiveSourceToolReceiptDelivery })
  }
  return { schemaVersion: OBJECTIVE_SOURCE_TOOL_RECEIPT_SCHEMA, graphRevision: Number(row.graphRevision),
    sourceKey: row.sourceKey, role: row.role as ObjectiveSourceToolReceiptRole, receipts: parsed }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  try {
    const keys = Reflect.ownKeys(value), prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    if (keys.some(key => typeof key !== 'string' || !Object.getOwnPropertyDescriptor(value, key)?.enumerable
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) return undefined
    return value as Record<string, unknown>
  } catch { return undefined }
}
function exact(row: Record<string, unknown>, keys: string): boolean {
  const expected = keys.split(',')
  return Reflect.ownKeys(row).length === expected.length && Object.keys(row).sort().join(',') === expected.sort().join(',')
}
function dense(value: unknown, maximum: number): unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return undefined
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1 || keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^\d+$/.test(key)))) return undefined
  const result: unknown[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return undefined
    result.push(descriptor.value)
  }
  return result
}
function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= OBJECTIVE_SOURCE_TOOL_RECEIPT_MAX_GRAPH_REVISION
}
function sourceKey(value: unknown): value is string { return typeof value === 'string' && /^src_[A-Za-z0-9_-]{43}$/.test(value) }
function receiptKey(value: unknown): value is string { return typeof value === 'string' && /^rcp_[A-Za-z0-9_-]{43}$/.test(value) }
