const SCALE = 8
const FACTOR = 10n ** BigInt(SCALE)
const MAX_SCALED = 999_999_999_999n

/** Matches PostgreSQL NUMERIC(12,8) rounding for nonnegative provider costs. */
export function childWaitPgCost(value: number): number | undefined {
  if (!Number.isFinite(value) || value < 0 || value >= 10_000) return undefined
  const match = /^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(value))
  if (!match) return undefined
  const fraction = match[2] ?? ""
  const exponent = Number(match[3] ?? "0")
  if (!Number.isSafeInteger(exponent)) return undefined
  const digits = BigInt(`${match[1]}${fraction}`)
  const shift = SCALE - (fraction.length - exponent)
  let scaled: bigint
  if (shift >= 0) scaled = digits * 10n ** BigInt(shift)
  else {
    const divisor = 10n ** BigInt(-shift)
    const quotient = digits / divisor
    scaled = quotient + (digits % divisor * 2n >= divisor ? 1n : 0n)
  }
  if (scaled > MAX_SCALED) return undefined
  return Number(scaled) / Number(FACTOR)
}

/** True only when a stored NUMERIC value is canonical and equals the receipt after DB rounding. */
export function childWaitStoredCostMatchesReceipt(stored: number, receipt: number): boolean {
  const persisted = childWaitPgCost(stored)
  const roundedReceipt = childWaitPgCost(receipt)
  return persisted !== undefined && roundedReceipt !== undefined && persisted === stored && persisted === roundedReceipt
}
