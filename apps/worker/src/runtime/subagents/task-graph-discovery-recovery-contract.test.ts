import { describe, expect, it } from "vitest"
import {
  DISCOVERY_RECOVERY_SCHEMA_VERSION, MAX_DISCOVERY_RECOVERY_JOB_IDS, parseDiscoveryRecovery,
} from "./task-graph-discovery-recovery-contract.js"

const jobId = (number: number) => `c${number.toString(36).padStart(24, "0")}`
const snapshot = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: DISCOVERY_RECOVERY_SCHEMA_VERSION,
  attemptCount: 2,
  jobIds: [jobId(1), "00000000-0000-4000-8000-000000000000"],
  truncated: false,
  ...overrides,
})

describe("TaskGraph discovery recovery sidecar contract", () => {
  it("accepts an empty receipt and canonical IDs while copying the closed snapshot", () => {
    expect(parseDiscoveryRecovery(snapshot({ jobIds: [] }))).toEqual({
      schemaVersion: DISCOVERY_RECOVERY_SCHEMA_VERSION, attemptCount: 2, jobIds: [], truncated: false,
    })
    const input = snapshot()
    const parsed = parseDiscoveryRecovery(input)
    expect(parsed).toEqual(input)
    expect(parsed?.jobIds).not.toBe(input.jobIds)
  })

  it("bounds attempts and IDs and permits truncation only at the cap", () => {
    const capped = Array.from({ length: MAX_DISCOVERY_RECOVERY_JOB_IDS }, (_, index) => jobId(index + 1))
    expect(parseDiscoveryRecovery(snapshot({ jobIds: capped, truncated: false }))?.jobIds).toHaveLength(MAX_DISCOVERY_RECOVERY_JOB_IDS)
    expect(parseDiscoveryRecovery(snapshot({ jobIds: capped, truncated: true }))?.truncated).toBe(true)
    expect(parseDiscoveryRecovery(snapshot({ jobIds: capped.slice(0, -1), truncated: true }))).toBeUndefined()
    expect(parseDiscoveryRecovery(snapshot({ jobIds: [...capped, jobId(25)] }))).toBeUndefined()
    expect(parseDiscoveryRecovery(snapshot({ attemptCount: 0 }))).toBeUndefined()
    expect(parseDiscoveryRecovery(snapshot({ attemptCount: 1_000_001 }))).toBeUndefined()
  })

  it("rejects duplicate or non-canonical IDs and unknown fields", () => {
    expect(parseDiscoveryRecovery(snapshot({ jobIds: [jobId(1), jobId(1)] }))).toBeUndefined()
    expect(parseDiscoveryRecovery(snapshot({ jobIds: ["provider-job-id"] }))).toBeUndefined()
    expect(parseDiscoveryRecovery({ ...snapshot(), privateResult: "model text" })).toBeUndefined()
  })

  it("rejects malformed objects, accessors, symbols, sparse arrays and proxies", () => {
    const accessor = snapshot()
    Object.defineProperty(accessor, "attemptCount", { enumerable: true, get: () => 2 })
    const symbol = snapshot()
    Object.defineProperty(symbol, Symbol("hidden"), { value: true })
    const sparse = [jobId(1), , jobId(3)]
    const proxy = new Proxy(snapshot(), {})
    expect(parseDiscoveryRecovery(null)).toBeUndefined()
    expect(parseDiscoveryRecovery(accessor)).toBeUndefined()
    expect(parseDiscoveryRecovery(symbol)).toBeUndefined()
    expect(parseDiscoveryRecovery(snapshot({ jobIds: sparse }))).toBeUndefined()
    expect(parseDiscoveryRecovery(proxy)).toBeUndefined()
  })
})
