type Row = Record<string, unknown>

export function isHistoryReceiptText(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.trim() === value
}

function historyReceiptObject(value: unknown): Row | null {
  let parsed = value
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed) as unknown } catch { return null }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try {
    const prototype = Object.getPrototypeOf(parsed)
    return prototype === Object.prototype || prototype === null ? parsed as Row : null
  } catch { return null }
}

export function parseHistoryReceiptSequence(value: unknown): bigint | undefined {
  if (typeof value !== "string" && typeof value !== "bigint") return undefined
  try { const parsed = BigInt(value); return parsed > 0n ? parsed : undefined } catch { return undefined }
}

export function validateHistoryStartReceipt(row: Row, turnId: string, rootTaskId: string): bigint | undefined {
  const payload = historyReceiptObject(row.startPayload), value = parseHistoryReceiptSequence(row.startSequence)
  return Number(row.startEventCount) === 1 && row.startTurnId === turnId && row.startTaskId === rootTaskId
    && row.startItemId === null && row.startType === "turn.started" && row.startActor === "orchestrator"
    && row.startCorrelationId === turnId && row.startIdempotencyKey === "turn:" + turnId + ":event:turn-started"
    && payload?.taskId === rootTaskId && payload.rootTaskId === rootTaskId ? value : undefined
}

export function validateHistoryTerminalReceipt(row: Row, turnId: string, rootTaskId: string, status: string, startSequence: bigint): bigint | undefined {
  const payload = historyReceiptObject(row.terminalPayload), value = parseHistoryReceiptSequence(row.terminalSequence)
  if (!payload || !value || Number(row.terminalEventCount) !== 1 || row.terminalTurnId !== turnId
    || row.terminalTaskId !== rootTaskId || row.terminalActor !== "orchestrator"
    || payload.turnId !== turnId || payload.taskId !== rootTaskId) return undefined
  const prefix = "turn:" + turnId + ":event:"
  if (status === "completed") {
    const stepPayload = historyReceiptObject(row.terminalStepEventPayload), stepSequence = parseHistoryReceiptSequence(row.terminalStepEventSequence)
    const exactStepPayload = !!stepPayload && Object.keys(stepPayload).sort().join(",") === "status,stepId,taskId"
    return row.terminalType === "turn.completed" && isHistoryReceiptText(payload.finalItemId) && row.terminalItemId === payload.finalItemId
      && isHistoryReceiptText(row.terminalCorrelationId) && row.terminalStepId === row.terminalCorrelationId
      && row.terminalStepSessionId === row.sessionId && row.terminalStepTurnId === turnId
      && row.terminalStepTaskId === rootTaskId && row.terminalStepStatus === "completed"
      && Number(row.terminalStepEventCount) === 1 && row.terminalStepEventSessionId === row.sessionId
      && row.terminalStepEventTurnId === turnId && row.terminalStepEventTaskId === rootTaskId
      && row.terminalStepEventItemId === null && row.terminalStepEventType === "step.completed"
      && row.terminalStepEventActor === "orchestrator" && row.terminalStepEventCorrelationId === row.terminalStepId
      && row.terminalStepEventIdempotencyKey === prefix + "step-completed:" + row.terminalStepId
      && stepSequence !== undefined && stepSequence > startSequence && stepSequence < value
      && exactStepPayload && stepPayload?.stepId === row.terminalStepId && stepPayload.status === "completed" && stepPayload.taskId === rootTaskId
      && row.terminalIdempotencyKey === prefix + "turn-completed" ? value : undefined
  }
  if (status === "failed") {
    return row.terminalType === "turn.failed" && isHistoryReceiptText(payload.errorCode)
      && (payload.finalItemId === null || isHistoryReceiptText(payload.finalItemId)) && row.terminalItemId === payload.finalItemId
      && row.terminalCorrelationId === turnId
      && row.terminalIdempotencyKey === prefix + "turn-failed:" + payload.errorCode ? value : undefined
  }
  return status === "interrupted" && row.terminalType === "turn.interrupted" && isHistoryReceiptText(payload.errorCode)
    && row.terminalItemId === null
    && row.terminalCorrelationId === turnId
    && row.terminalIdempotencyKey === prefix + "turn-interrupted" ? value : undefined
}
