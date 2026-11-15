import { describe, expect, it } from "vitest"
import { readFile } from "node:fs/promises"

type WaitResolverLogger = (say: (line: string) => void, targetConsole?: { error: (...args: unknown[]) => void }) => void
type DiagnosticConsole = { error: (...args: unknown[]) => void }

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

async function waitResolverLogger(): Promise<WaitResolverLogger> {
  const loaded: unknown = await import(new URL("./nested-scout-wait-resolver-logging.mjs", import.meta.url).href)
  const install = record(loaded)?.installWaitResolverDiagnostics
  if (typeof install !== "function") throw new Error("wait resolver logger is unavailable")
  return install as WaitResolverLogger
}

function diagnosticConsole(install: WaitResolverLogger) {
  const output: string[] = [], forwarded: unknown[][] = []
  const targetConsole: DiagnosticConsole = { error: (...args) => { forwarded.push(args) } }
  install(line => output.push(line), targetConsole)
  return { output, forwarded, error: targetConsole.error }
}

const PREFIX = "[wait-resolver] scan failed:"

describe("nested Scout wait-resolver logging", () => {
  it("passes the fixture marker writer to the production logger installation", async () => {
    const fixture = await readFile(new URL("./nested-scout-delegation-worker.fixture.mjs", import.meta.url), "utf8")

    expect(fixture).toContain("installWaitResolverDiagnostics(say)")
    expect(fixture).not.toContain("installWaitResolverDiagnostics()")
  })

  it("preserves every fixed error category and deduplicates by normalized category", async () => {
    const install = await waitResolverLogger()
    const logger = diagnosticConsole(install)
    const codes = [
      "idempotency_conflict", "revision_mismatch", "wait_invalid", "wait_scope_error", "wait_conflict",
      "40001", "40P01", "55P03", "57014", "08000", "08003", "08006", "57P01", "ECONNRESET", "ETIMEDOUT",
      "error", "unknown", "other", "child_wait_configuration", "child_wait_deadline_revalidation",
      "child_wait_parent_deadline_scope", "child_wait_schedule_fence", "child_wait_session_scope",
      "task_graph_prepare_or_load", "task_graph_transition_rejected", "task_graph_persist_revision_conflict",
      "task_graph_persist_outbox_conflict", "task_graph_persist_sequence_unavailable",
    ]

    for (const code of codes) logger.error(PREFIX, { code })
    logger.error(PREFIX, { code: "wait_conflict" })
    logger.error(PREFIX, { code: "unrecognized_private_code" })

    expect(logger.output).toEqual(codes.map(code => `P1143_WAIT_RESOLVER_ERROR:${code}`))
  })

  it("matches exception messages exactly and logs only fixed codes", async () => {
    const install = await waitResolverLogger()
    const logger = diagnosticConsole(install)
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["Child wait deadline could not be revalidated", "child_wait_deadline_revalidation"],
      ["Child wait parent deadline scope could not be revalidated", "child_wait_parent_deadline_scope"],
      ["Child wait schedule update lost its eligibility fence", "child_wait_schedule_fence"],
      ["Child wait session scope is invalid", "child_wait_session_scope"],
      ["Child wait resolver batch size must be between 1 and 100", "child_wait_configuration"],
      ["Child wait resolver options are invalid", "child_wait_configuration"],
      ["task_graph_attempt_count_invalid", "task_graph_prepare_or_load"],
      ["task_graph_event_outbox_conflict", "task_graph_persist_outbox_conflict"],
      ["task_graph_session_sequence_unavailable", "task_graph_persist_sequence_unavailable"],
      ["task_graph_item_revision_conflict", "task_graph_persist_revision_conflict"],
      ["task_graph_transition_rejected:invalid_transition", "task_graph_transition_rejected"],
      ["task_graph_transition_rejected:idempotency_conflict", "idempotency_conflict"],
      ["task_graph_transition_rejected:revision_mismatch", "revision_mismatch"],
    ]

    for (const [message] of cases) logger.error(PREFIX, new Error(message))
    logger.error(PREFIX, new Error("Child wait deadline could not be revalidated: private detail"))
    logger.error(PREFIX, new Error("private exception text with user identifier"))

    expect(logger.output).toEqual([
      ...new Set(cases.map(([, code]) => `P1143_WAIT_RESOLVER_ERROR:${code}`)),
      "P1143_WAIT_RESOLVER_ERROR:error",
    ])
    expect(logger.output.join(" ")).not.toContain("private detail")
    expect(logger.output.join(" ")).not.toContain("user identifier")
  })

  it("intercepts only the exact wait-resolver prefix and forwards unrelated console errors", async () => {
    const install = await waitResolverLogger()
    const logger = diagnosticConsole(install)
    const secretError = new Error("private error message")

    logger.error(`${PREFIX} extra`, secretError)
    logger.error("[unrelated] scan failed:", secretError)
    logger.error(PREFIX, secretError)
    logger.error(PREFIX, new Error("different private error message"))

    expect(logger.output).toEqual(["P1143_WAIT_RESOLVER_ERROR:error"])
    expect(logger.forwarded).toHaveLength(2)
    expect(logger.forwarded[0][0]).toBe(`${PREFIX} extra`)
    expect(logger.forwarded[0][1]).toBe(secretError)
    expect(logger.forwarded[1][0]).toBe("[unrelated] scan failed:")
    expect(logger.forwarded[1][1]).toBe(secretError)
    expect(logger.output.join(" ")).not.toContain("private error message")
  })
})
