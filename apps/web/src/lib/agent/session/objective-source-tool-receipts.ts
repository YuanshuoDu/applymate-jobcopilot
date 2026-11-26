import type { Prisma } from '@prisma/client'

import { readObjectiveJourneyProofContext, type ObjectiveJourneyProofContext } from './objective-journey-report-source'
import { readObjectiveTaskToolReceiptSet } from './objective-journey-report-requirement-receipts'
import {
  proveObjectiveSourceToolReceipts,
  resolveObjectiveSourceToolScope,
} from './objective-source-tool-receipt-proof'
import {
  OBJECTIVE_SOURCE_TOOL_RECEIPT_MAX_GRAPH_REVISION,
  parseObjectiveSourceToolReceiptEvidence,
  type ObjectiveSourceToolReceiptEvidence,
} from './objective-source-tool-receipts-contract'

type Tx = Prisma.TransactionClient
type Input = Readonly<{ userId: string; sessionId: string; finalItemId: string; sourceKey: string; graphRevision: number }>

/** Joins the owner/revision/source proof to the private receipt reader and emits only its closed projection. */
export async function readObjectiveSourceToolReceipts(tx: Tx, input: Input): Promise<ObjectiveSourceToolReceiptEvidence | undefined> {
  if (!validInput(input)) return undefined
  let context: ObjectiveJourneyProofContext | null
  try { context = await readObjectiveJourneyProofContext(tx, input, input.graphRevision) } catch { return undefined }
  if (!context || context.userId !== input.userId || context.sessionId !== input.sessionId
    || context.finalItemId !== input.finalItemId || context.graphRevision !== input.graphRevision) return undefined

  let resolved: ReturnType<typeof resolveObjectiveSourceToolScope>
  try { resolved = resolveObjectiveSourceToolScope(context, input.sourceKey) } catch { return undefined }
  if (!resolved) return undefined

  try {
    const receiptSet = await readObjectiveTaskToolReceiptSet(tx, resolved.scope)
    if (!receiptSet) return undefined
    const proof = await proveObjectiveSourceToolReceipts(context, resolved, receiptSet)
    const evidence = parseObjectiveSourceToolReceiptEvidence(proof)
    return evidence && evidence.graphRevision === input.graphRevision && evidence.sourceKey === input.sourceKey
      && evidence.role === resolved.role ? evidence : undefined
  } catch { return undefined }
}

function validInput(input: Input): boolean {
  return [input.userId, input.sessionId, input.finalItemId].every(validId)
    && /^src_[A-Za-z0-9_-]{43}$/.test(input.sourceKey)
    && Number.isSafeInteger(input.graphRevision) && input.graphRevision > 0
    && input.graphRevision <= OBJECTIVE_SOURCE_TOOL_RECEIPT_MAX_GRAPH_REVISION
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value)
}
