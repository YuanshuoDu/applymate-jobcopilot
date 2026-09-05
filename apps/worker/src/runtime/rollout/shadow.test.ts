import { describe, expect, it, vi } from "vitest"

import {
  DoubleExecutionBlockedError,
  runV1AndV2InParallel,
  type ShadowComparison,
  type ShadowSession,
} from "./shadow.js"
import type { ToolExecutionContext } from "../tools/types.js"

function executionContext(): ToolExecutionContext {
  return {
    scope: { userId: "user-1" },
    sessionId: "session-1",
    turnId: "turn-1",
    stepId: "step-1",
    signal: new AbortController().signal,
    capabilities: ["submission"],
    reportProgress: vi.fn(async () => undefined),
  }
}

function session<TInput, TV1, TV2>(
  overrides: Partial<ShadowSession<TInput, TV1, TV2>>,
): ShadowSession<TInput, TV1, TV2> {
  return {
    id: "session-1",
    executionContext: executionContext(),
    runV1: vi.fn(async () => ({ version: "v1" } as TV1)),
    runV2: vi.fn(async () => ({ version: "v2" } as TV2)),
    executeExternal: vi.fn(async (_context, operation) => operation()),
    recorder: { record: vi.fn() },
    now: (() => {
      let tick = 100
      return () => tick++
    })(),
    ...overrides,
  }
}

describe("shadow comparator", () => {
  it("runs both branches, returns V2 authority, and records only metric differences", async () => {
    let v1Allowed: boolean | undefined
    let v2Allowed: boolean | undefined
    const record = vi.fn<(comparison: ShadowComparison) => void>()
    const current = session({
      runV1: async (_input, context) => {
        v1Allowed = context.externalExecutionAllowed
        return { answer: "legacy" }
      },
      runV2: async (_input, context) => {
        v2Allowed = context.externalExecutionAllowed
        return { answer: "harness" }
      },
      recorder: { record },
    })

    const result = await runV1AndV2InParallel(current, { jobId: "job-1" })

    expect(result.authority).toEqual({ answer: "harness" })
    expect(result.advisory).toMatchObject({ status: "completed", output: { answer: "legacy" } })
    expect(v1Allowed).toBe(false)
    expect(v2Allowed).toBe(true)
    expect(record).toHaveBeenCalledOnce()
    expect(record.mock.calls[0]?.[0]).toMatchObject({ sessionId: "session-1" })
    expect(record.mock.calls[0]?.[0]).not.toHaveProperty("v1.output")
    expect(record.mock.calls[0]?.[0].differences).toContain("result_digest")
  })

  it("blocks a V1 real submission and allows at most the V2 external execution", async () => {
    let externalExecutions = 0
    const record = vi.fn<(comparison: ShadowComparison) => void>()
    const current = session({
      runV1: async (_input, context) => {
        await context.submitExternal(async () => {
          externalExecutions += 1
          return "must-not-run"
        }).catch(() => undefined)
        return { dryRun: true }
      },
      runV2: async (_input, context) => ({
        confirmation: await context.submitExternal(async () => {
          externalExecutions += 1
          return "v2-confirmation"
        }),
      }),
      recorder: { record },
    })

    const error = await runV1AndV2InParallel(current, { jobId: "job-1" }).catch(value => value)

    expect(error).toBeInstanceOf(DoubleExecutionBlockedError)
    expect(error).toMatchObject({ code: "double_execution_blocked" })
    expect(externalExecutions).toBe(1)
    expect(record.mock.calls[0]?.[0].v1.externalExecutionAttempted).toBe(true)
    expect(record.mock.calls[0]?.[0].v2.externalExecutionAttempted).toBe(true)
  })

  it("treats a V1 failure as advisory while preserving a successful V2 authority", async () => {
    const record = vi.fn<(comparison: ShadowComparison) => void>()
    const current = session({
      runV1: async () => { throw Object.assign(new Error("legacy provider unavailable"), { code: "legacy_unavailable" }) },
      runV2: async () => ({ status: "completed", source: "v2" }),
      recorder: { record },
    })

    const result = await runV1AndV2InParallel(current, { jobId: "job-1" })

    expect(result.authority).toEqual({ status: "completed", source: "v2" })
    expect(result.advisory).toMatchObject({ status: "failed", errorCode: "legacy_unavailable" })
    expect(record.mock.calls[0]?.[0].v1).toMatchObject({ status: "failed", errorCode: "legacy_unavailable" })
    expect(record.mock.calls[0]?.[0].v2).toMatchObject({ status: "completed", errorCode: null })
  })
})
