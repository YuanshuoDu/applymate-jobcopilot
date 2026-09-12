import { describe, expect, it, vi } from "vitest"

import {
  createProductionContextCompactionOptions,
  DEFAULT_CONTEXT_COMPACTION_KEEP_RECENT_OBSERVATIONS,
  DEFAULT_CONTEXT_COMPACTION_OBSERVATION_THRESHOLD,
  resolveProductionContextCompactionConfig,
} from "./production-context-compaction.js"

function pool() {
  return { connect: vi.fn() }
}

describe("production context compaction", () => {
  it("keeps the adapter absent and leaves configuration unparsed when disabled", () => {
    expect(createProductionContextCompactionOptions({
      enabled: false,
      pool: pool(),
      env: { AGENT_CONTEXT_COMPACTION_OBSERVATION_THRESHOLD: "invalid" },
    })).toEqual({})
  })

  it("uses bounded defaults", () => {
    expect(resolveProductionContextCompactionConfig({})).toEqual({
      observationCountThreshold: DEFAULT_CONTEXT_COMPACTION_OBSERVATION_THRESHOLD,
      keepRecentObservations: DEFAULT_CONTEXT_COMPACTION_KEEP_RECENT_OBSERVATIONS,
    })
  })

  it("accepts valid threshold boundaries when the keep window remains smaller", () => {
    expect(resolveProductionContextCompactionConfig({
      AGENT_CONTEXT_COMPACTION_OBSERVATION_THRESHOLD: "2",
      AGENT_CONTEXT_COMPACTION_KEEP_RECENT_OBSERVATIONS: "1",
    })).toEqual({ observationCountThreshold: 2, keepRecentObservations: 1 })
    expect(resolveProductionContextCompactionConfig({
      AGENT_CONTEXT_COMPACTION_OBSERVATION_THRESHOLD: "64",
      AGENT_CONTEXT_COMPACTION_KEEP_RECENT_OBSERVATIONS: "63",
    })).toEqual({ observationCountThreshold: 64, keepRecentObservations: 63 })
    expect(resolveProductionContextCompactionConfig({
      AGENT_CONTEXT_COMPACTION_OBSERVATION_THRESHOLD: "12",
      AGENT_CONTEXT_COMPACTION_KEEP_RECENT_OBSERVATIONS: "1",
    })).toEqual({ observationCountThreshold: 12, keepRecentObservations: 1 })
  })

  it("rejects out of range, malformed, and ineffective settings", () => {
    for (const value of ["0", "65", "1.5", "-1", "1e1", "true", ""]) {
      expect(() => resolveProductionContextCompactionConfig({ AGENT_CONTEXT_COMPACTION_OBSERVATION_THRESHOLD: value })).toThrow("AGENT_CONTEXT_COMPACTION_OBSERVATION_THRESHOLD")
    }
    for (const value of ["0", "65", "1.5", "-1", "1e1", "true", ""]) {
      expect(() => resolveProductionContextCompactionConfig({ AGENT_CONTEXT_COMPACTION_KEEP_RECENT_OBSERVATIONS: value })).toThrow("AGENT_CONTEXT_COMPACTION_KEEP_RECENT_OBSERVATIONS")
    }
    expect(() => resolveProductionContextCompactionConfig({
      AGENT_CONTEXT_COMPACTION_OBSERVATION_THRESHOLD: "12",
      AGENT_CONTEXT_COMPACTION_KEEP_RECENT_OBSERVATIONS: "12",
    })).toThrow("must be less than")
    expect(() => resolveProductionContextCompactionConfig({
      AGENT_CONTEXT_COMPACTION_OBSERVATION_THRESHOLD: "1",
      AGENT_CONTEXT_COMPACTION_KEEP_RECENT_OBSERVATIONS: "1",
    })).toThrow("must be less than")
    expect(() => createProductionContextCompactionOptions({
      enabled: true,
      pool: pool(),
      env: { AGENT_CONTEXT_COMPACTION_OBSERVATION_THRESHOLD: "65" },
    })).toThrow("AGENT_CONTEXT_COMPACTION_OBSERVATION_THRESHOLD")
  })

  it("injects the adapter options only when enabled", () => {
    const disabledPool = pool()
    expect(createProductionContextCompactionOptions({ enabled: false, pool: disabledPool })).toEqual({})
    expect(disabledPool.connect).not.toHaveBeenCalled()

    const enabledPool = pool()
    const enabled = createProductionContextCompactionOptions({ enabled: true, pool: enabledPool, env: {
      AGENT_CONTEXT_COMPACTION_OBSERVATION_THRESHOLD: "2",
      AGENT_CONTEXT_COMPACTION_KEEP_RECENT_OBSERVATIONS: "1",
    } })
    expect(enabled.contextSnapshotAdapter).toBeDefined()
    expect(enabled.contextSnapshotAdapter).toEqual(expect.objectContaining({ hook: expect.any(Function), loadSnapshot: expect.any(Function) }))
    expect(enabledPool.connect).not.toHaveBeenCalled()
  })
})
