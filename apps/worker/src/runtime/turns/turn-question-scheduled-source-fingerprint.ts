type Fingerprint = Record<string, unknown>
type SourceFingerprintRow = readonly [jobId: string, version: string, digest: string]

const VERSION = "agent-harness.v2.analyze-source-input.v1"
const DIGEST = /^[0-9a-f]{64}$/

/** Projects the exact Web Analyze fingerprint map into its canonical digest rows. */
export function scheduledAnalyzeSourceFingerprintRows(
  jobIds: readonly string[], value: unknown,
): readonly SourceFingerprintRow[] | null {
  if (!Array.isArray(jobIds) || jobIds.some(id => !validId(id)) || new Set(jobIds).size !== jobIds.length) return null
  const expected = [...jobIds].sort()
  if (expected.length === 0) return value === undefined || isEmptyRecord(value) ? [] : null
  const map = record(value)
  if (!map || !exactKeys(map, expected)) return null
  const rows: SourceFingerprintRow[] = []
  for (const jobId of expected) {
    const fingerprint = record(map[jobId])
    if (!fingerprint || !exactKeys(fingerprint, ["digest", "version"]) || fingerprint.version !== VERSION
      || typeof fingerprint.digest !== "string" || !DIGEST.test(fingerprint.digest)) return null
    rows.push([jobId, VERSION, fingerprint.digest])
  }
  return rows
}

export function isCanonicalAnalyzeSourceFenceTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function isEmptyRecord(value: unknown): boolean {
  const row = record(value)
  return Boolean(row && Reflect.ownKeys(row).length === 0)
}

function record(value: unknown): Fingerprint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null ? value as Fingerprint : null
  } catch { return null }
}

function exactKeys(value: Fingerprint, expected: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value)
  return actual.length === expected.length && actual.every(key => typeof key === "string" && expected.includes(key))
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value)
}
