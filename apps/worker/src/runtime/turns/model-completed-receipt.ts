type Row = Record<string, unknown>
export type ModelCompletedReceipt = { readonly taskId: string; readonly provider: string; readonly model: string; readonly toolCallCount?: number }
function row(value: unknown): Row | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null }

/** Parses the exact historical or current server receipt shape; callers still bind event identity. */
export function parseModelCompletedReceipt(value: unknown): ModelCompletedReceipt | null {
  const payload = row(value), keys = payload && Reflect.ownKeys(payload)
  if (!payload || (Object.getPrototypeOf(payload) !== Object.prototype && Object.getPrototypeOf(payload) !== null)
    || !keys || (keys.length !== 3 && keys.length !== 4)
    || keys.some(key => typeof key !== "string" || !["taskId", "provider", "model", "toolCallCount"].includes(key))
    || !["taskId", "provider", "model"].every(key => { const descriptor = Object.getOwnPropertyDescriptor(payload, key); return !!descriptor?.enumerable && "value" in descriptor })
    || typeof payload.taskId !== "string" || !payload.taskId || typeof payload.provider !== "string" || !payload.provider
    || typeof payload.model !== "string" || !payload.model) return null
  const hasCount = Object.hasOwn(payload, "toolCallCount")
  const countDescriptor = Object.getOwnPropertyDescriptor(payload, "toolCallCount")
  if (hasCount && (!countDescriptor?.enumerable || !("value" in countDescriptor)
    || !Number.isSafeInteger(payload.toolCallCount) || Number(payload.toolCallCount) < 0)) return null
  if (keys.length !== (hasCount ? 4 : 3)) return null
  return { taskId: payload.taskId, provider: payload.provider, model: payload.model, ...(hasCount ? { toolCallCount: Number(payload.toolCallCount) } : {}) }
}
