export const LEGACY_TRAFFIC_KEYS = [
  "agent_run_endpoint",
  "agent_chat_endpoint",
  "agent_stream_connect",
] as const

export type LegacyTrafficKey = (typeof LEGACY_TRAFFIC_KEYS)[number]

export interface LegacyTrafficSnapshot {
  asOf: string
  windowStart: string
  windowEnd: string
  total: number
  byKey: Readonly<Record<LegacyTrafficKey, number>>
  windowTotal: number
  windowByKey: Readonly<Record<LegacyTrafficKey, number>>
  lastHitAt: string | null
  zeroForSevenDays: boolean
}

export interface LegacyTrafficCounter {
  hit(key: LegacyTrafficKey, at?: Date | string): void
  snapshot(at?: Date | string): LegacyTrafficSnapshot
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000

/**
 * Process-local diagnostic counters. Production zero-traffic sign-off must
 * still use the deployment's durable request logs; a warm-instance counter is
 * not evidence that traffic was absent from every replica.
 */
export function createLegacyTrafficCounter(): LegacyTrafficCounter {
  const totals = emptyCounts()
  const hits = emptyHitLists()
  let lastHitAt: Date | null = null

  return {
    hit(key, at = new Date()) {
      assertLegacyTrafficKey(key)
      const date = validDate(at, "hit time")
      totals[key] += 1
      hits[key].push(date)
      if (!lastHitAt || date.getTime() > lastHitAt.getTime()) lastHitAt = date
    },

    snapshot(at = new Date()) {
      const asOf = validDate(at, "snapshot time")
      const windowStart = new Date(asOf.getTime() - SEVEN_DAYS_MS)
      const windowByKey = emptyCounts()

      for (const key of LEGACY_TRAFFIC_KEYS) {
        const retained = hits[key].filter((date) => date.getTime() >= windowStart.getTime())
        hits[key] = retained
        windowByKey[key] = retained.reduce(
          (count, date) => count + (date.getTime() <= asOf.getTime() ? 1 : 0),
          0,
        )
      }

      const windowTotal = sum(windowByKey)
      return {
        asOf: asOf.toISOString(),
        windowStart: windowStart.toISOString(),
        windowEnd: asOf.toISOString(),
        total: sum(totals),
        byKey: { ...totals },
        windowTotal,
        windowByKey: { ...windowByKey },
        lastHitAt: lastHitAt?.toISOString() ?? null,
        zeroForSevenDays: windowTotal === 0,
      }
    },
  }
}

export const legacyTrafficCounter = createLegacyTrafficCounter()

export function recordLegacyTraffic(key: LegacyTrafficKey, at?: Date | string): void {
  legacyTrafficCounter.hit(key, at)
}

export function legacyTrafficSnapshot(at?: Date | string): LegacyTrafficSnapshot {
  return legacyTrafficCounter.snapshot(at)
}

export function isLegacyTrafficKey(value: unknown): value is LegacyTrafficKey {
  return typeof value === "string" && (LEGACY_TRAFFIC_KEYS as readonly string[]).includes(value)
}

function assertLegacyTrafficKey(value: unknown): asserts value is LegacyTrafficKey {
  if (!isLegacyTrafficKey(value)) throw new Error("legacy traffic key is not supported")
}

type Counts = Record<LegacyTrafficKey, number>
type HitLists = Record<LegacyTrafficKey, Date[]>

function emptyCounts(): Counts {
  return Object.fromEntries(LEGACY_TRAFFIC_KEYS.map((key) => [key, 0])) as Counts
}

function emptyHitLists(): HitLists {
  const lists = {} as HitLists
  for (const key of LEGACY_TRAFFIC_KEYS) lists[key] = []
  return lists
}

function sum(counts: Counts): number {
  return LEGACY_TRAFFIC_KEYS.reduce((total, key) => total + counts[key], 0)
}

function validDate(value: Date | string, label: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid date`)
  return date
}
