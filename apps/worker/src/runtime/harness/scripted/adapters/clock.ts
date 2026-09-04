export type ScriptedClock = {
  readonly startMs: number
  now(): Date
  nowIso(): string
  advance(milliseconds?: number): Date
}

export function scriptedClock(options: { readonly start: string | number | Date; readonly advance?: number }): ScriptedClock {
  const startMs = parseTime(options.start)
  const defaultAdvance = options.advance ?? 25
  if (!Number.isFinite(defaultAdvance) || defaultAdvance < 0) throw new TypeError("clock advance must be non-negative")
  let currentMs = startMs
  return {
    startMs,
    now: () => new Date(currentMs),
    nowIso: () => new Date(currentMs).toISOString(),
    advance: (milliseconds = defaultAdvance) => {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new TypeError("clock advance must be non-negative")
      currentMs += milliseconds
      return new Date(currentMs)
    },
  }
}

function parseTime(value: string | number | Date): number {
  const result = typeof value === "number" ? value : value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(result)) throw new TypeError("clock start must be a valid time")
  return result
}
