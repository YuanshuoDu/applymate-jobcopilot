export const OBJECTIVE_SLOT_REVIEWER_RECEIPT_SCHEMA = "agent-harness.v2.objective-slot-reviewer-receipt.v1" as const

export type ObjectiveSlotReviewerReceipt = Readonly<{
  schemaVersion: typeof OBJECTIVE_SLOT_REVIEWER_RECEIPT_SCHEMA
  graphRevision: number
  slotOrdinal: number
  artifactVersion: number
  outcome: "passed"
  receiptKey: string
}>

export function parseObjectiveSlotReviewerReceiptResponse(value: unknown, expected: Readonly<{ graphRevision: number; slotOrdinal: number }>): ObjectiveSlotReviewerReceipt | null {
  const envelope = record(value), receipt = envelope && record(envelope.reviewerReceipt)
  if (!envelope || !receipt || !exactKeys(envelope, ["reviewerReceipt"]) || !exactKeys(receipt,
    ["artifactVersion", "graphRevision", "outcome", "receiptKey", "schemaVersion", "slotOrdinal"])) return null
  if (!positive(expected.graphRevision) || !positive(expected.slotOrdinal) || expected.slotOrdinal > 8
    || receipt.schemaVersion !== OBJECTIVE_SLOT_REVIEWER_RECEIPT_SCHEMA || receipt.outcome !== "passed"
    || receipt.graphRevision !== expected.graphRevision || receipt.slotOrdinal !== expected.slotOrdinal
    || !positive(receipt.artifactVersion) || typeof receipt.receiptKey !== "string" || !/^review-[a-f0-9]{64}$/.test(receipt.receiptKey)) return null
  return { schemaVersion: OBJECTIVE_SLOT_REVIEWER_RECEIPT_SCHEMA, graphRevision: receipt.graphRevision,
    slotOrdinal: receipt.slotOrdinal, artifactVersion: receipt.artifactVersion, outcome: "passed", receiptKey: receipt.receiptKey }
}

type Row = Record<string, unknown>
function exactKeys(value: Row, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }
function record(value: unknown): Row | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const keys = Reflect.ownKeys(value)
    return (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
      && keys.every(key => typeof key === "string" && Object.getOwnPropertyDescriptor(value, key)?.enumerable
        && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value")) ? value as Row : undefined
  } catch { return undefined }
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
