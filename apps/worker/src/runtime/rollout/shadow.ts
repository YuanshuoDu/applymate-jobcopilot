import { createHash } from "node:crypto"

import type { ToolExecutionContext } from "../tools/types.js"

/** The only error a V1 shadow path may expose when it attempts an external write. */
export class DoubleExecutionBlockedError extends Error {
  readonly code = "double_execution_blocked" as const

  constructor() {
    super("V1 shadow execution cannot perform an external action")
    this.name = "DoubleExecutionBlockedError"
  }
}

export type ShadowExecutionContext = ToolExecutionContext & {
  readonly externalExecutionAllowed: boolean
  submitExternal<T>(operation: () => Promise<T>): Promise<T>
  /** Alias for typed executors that model the boundary as execution rather than submission. */
  executeExternal<T>(operation: () => Promise<T>): Promise<T>
}

export type ShadowExecutor<TInput, TOutput> = (
  input: TInput,
  context: ShadowExecutionContext,
) => Promise<TOutput>

export type ExternalExecutionBoundary = <T>(
  context: ToolExecutionContext,
  operation: () => Promise<T>,
) => Promise<T>

export type ShadowBranchMetrics = {
  readonly status: "completed" | "failed"
  readonly durationMs: number
  readonly resultDigest: string | null
  readonly errorCode: string | null
  readonly externalExecutionAttempted: boolean
}

export type ShadowBranchOutcome<TOutput> = ShadowBranchMetrics & {
  readonly output?: TOutput
}

export type ShadowDifferenceField =
  | "status"
  | "result_digest"
  | "error_code"
  | "external_execution_attempted"

export type ShadowComparison = {
  readonly sessionId: string
  readonly v1: ShadowBranchMetrics
  readonly v2: ShadowBranchMetrics
  readonly differences: readonly ShadowDifferenceField[]
}

/** Narrow sink for metrics-only rollout evidence. It must never receive branch output. */
export interface ShadowComparisonRecorder {
  record(comparison: ShadowComparison): void | Promise<void>
}

export type ShadowSession<TInput, TV1, TV2> = {
  readonly id: string
  readonly executionContext: ToolExecutionContext
  readonly runV1: ShadowExecutor<TInput, TV1>
  readonly runV2: ShadowExecutor<TInput, TV2>
  readonly executeExternal: ExternalExecutionBoundary
  readonly recorder: ShadowComparisonRecorder
  readonly now?: () => number
}

export type ShadowRunResult<TV1, TV2> = {
  /** V2 is the only branch whose successful output may drive the caller. */
  readonly authority: TV2
  /** V1 is evidence only; a V1 failure never hides a successful V2 result. */
  readonly advisory: ShadowBranchOutcome<TV1>
  readonly comparison: ShadowComparison
}

type InternalBranchOutcome<TOutput> = ShadowBranchOutcome<TOutput> & { readonly error?: unknown }

/**
 * Execute legacy V1 and Harness V2 concurrently for one session.
 *
 * The caller supplies the existing typed execution context and external-action
 * boundary. V1 receives a fail-closed context; V2 receives the same context
 * with the boundary enabled. Only the V2 output is returned as authority.
 */
export async function runV1AndV2InParallel<TInput, TV1, TV2>(
  session: ShadowSession<TInput, TV1, TV2>,
  input: TInput,
): Promise<ShadowRunResult<TV1, TV2>> {
  if (session.id !== session.executionContext.sessionId) throw new Error("Shadow session context does not match session id")

  const clock = session.now ?? Date.now
  let v1ExternalAttempted = false
  let v2ExternalAttempted = false
  const v1Context = makeContext(session, false, () => { v1ExternalAttempted = true })
  const v2Context = makeContext(session, true, () => { v2ExternalAttempted = true })

  const [v1, v2] = await Promise.all([
    runBranch(session.runV1, input, v1Context, clock, () => v1ExternalAttempted),
    runBranch(session.runV2, input, v2Context, clock, () => v2ExternalAttempted),
  ])
  const comparison = compareBranches(session.id, metricsOf(v1), metricsOf(v2))

  // Metrics persistence is deliberately non-blocking for the authority path.
  await Promise.resolve(session.recorder.record(comparison)).catch(() => undefined)

  if (v1.externalExecutionAttempted) throw new DoubleExecutionBlockedError()
  if (v2.status === "failed") throw v2.error ?? new Error("V2 shadow execution failed")
  return { authority: v2.output as TV2, advisory: withoutInternalError(v1), comparison }
}

function makeContext<TInput, TV1, TV2>(
  session: ShadowSession<TInput, TV1, TV2>,
  externalExecutionAllowed: boolean,
  onAttempt: () => void,
): ShadowExecutionContext {
  const submitExternal = async <T>(operation: () => Promise<T>): Promise<T> => {
    onAttempt()
    if (!externalExecutionAllowed) throw new DoubleExecutionBlockedError()
    return session.executeExternal(session.executionContext, operation)
  }
  return Object.freeze({
    ...session.executionContext,
    externalExecutionAllowed,
    submitExternal,
    executeExternal: submitExternal,
  })
}

async function runBranch<TInput, TOutput>(
  execute: ShadowExecutor<TInput, TOutput>,
  input: TInput,
  context: ShadowExecutionContext,
  clock: () => number,
  attempted: () => boolean,
): Promise<InternalBranchOutcome<TOutput>> {
  const startedAt = clock()
  try {
    const output = await execute(input, context)
    return {
      status: "completed",
      durationMs: elapsed(clock, startedAt),
      resultDigest: digest(output),
      errorCode: null,
      externalExecutionAttempted: attempted(),
      output,
    }
  } catch (error: unknown) {
    return {
      status: "failed",
      durationMs: elapsed(clock, startedAt),
      resultDigest: null,
      errorCode: safeErrorCode(error),
      externalExecutionAttempted: attempted(),
      error,
    }
  }
}

function compareBranches(sessionId: string, v1: ShadowBranchMetrics, v2: ShadowBranchMetrics): ShadowComparison {
  const differences: ShadowDifferenceField[] = []
  if (v1.status !== v2.status) differences.push("status")
  if (v1.resultDigest !== v2.resultDigest) differences.push("result_digest")
  if (v1.errorCode !== v2.errorCode) differences.push("error_code")
  if (v1.externalExecutionAttempted !== v2.externalExecutionAttempted) differences.push("external_execution_attempted")
  return { sessionId, v1, v2, differences }
}

function metricsOf<TOutput>(outcome: ShadowBranchOutcome<TOutput>): ShadowBranchMetrics {
  return {
    status: outcome.status,
    durationMs: outcome.durationMs,
    resultDigest: outcome.resultDigest,
    errorCode: outcome.errorCode,
    externalExecutionAttempted: outcome.externalExecutionAttempted,
  }
}

function withoutInternalError<TOutput>(outcome: InternalBranchOutcome<TOutput>): ShadowBranchOutcome<TOutput> {
  const { error: _error, ...publicOutcome } = outcome
  return publicOutcome
}

function elapsed(clock: () => number, startedAt: number): number {
  return Math.max(0, Math.round(clock() - startedAt))
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === "string" && /^[a-z0-9_.-]{1,96}$/i.test(code)) return code
  }
  return "shadow_execution_failed"
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableEncode(value)).digest("hex")
}

function stableEncode(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "bigint") return JSON.stringify(`${value.toString()}n`)
  if (typeof value !== "object") return JSON.stringify(`[${typeof value}]`)
  if (seen.has(value)) return JSON.stringify("[cycle]")
  seen.add(value)
  if (Array.isArray(value)) return `[${value.map(item => stableEncode(item, seen)).join(",")}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableEncode((value as Record<string, unknown>)[key], seen)}`).join(",")}}`
}
