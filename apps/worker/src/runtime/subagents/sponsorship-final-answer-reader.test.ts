import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { readSponsorshipFinalAnswerWithClient } from "./sponsorship-final-answer-reader.js"
import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"

const controls = vi.hoisted(() => ({ read: vi.fn(async () => []) }))
vi.mock("./native-verification-pg-request.js", () => ({ readNativeVerificationControlTasks: controls.read }))

const scope: TaskGraphExecutionScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  parentTaskId: "root-1", turnLeaseOwner: "worker-1", turnLeaseVersion: 2, parentLeaseOwner: "worker-1",
  parentAttemptCount: 3, stepId: "step-1" }
const countryInput = { goal: "Find roles", intent: { kind: "objective_task_graph_execution", version: 1 },
  sponsorshipTargetCountry: { schemaVersion: "agent-harness.v2.objective-sponsorship-target-country.v1", countryCode: "IE" } }
const graphBinding = { rootTaskId: "root-1", graphRevision: 1, members: [], summary: { discoveredJobs: [] } } as never

function clientFor(stepStatus: "streaming" | "completed" | "failed") {
  const statements: string[] = []
  const query = vi.fn(async (sql: string) => {
    statements.push(sql.replace(/\s+/gu, " ").trim())
    if (sql.includes("set_config")) return { rows: [] }
    if (sql.includes('SELECT "id" FROM "agent_sessions"')) return { rows: [{ id: "session-1" }] }
    if (sql.includes('SELECT "id" FROM "agent_turns"')) return { rows: [{ id: "turn-1" }] }
    if (sql.includes('SELECT task.*')) return { rows: [{ id: "root-1" }] }
    if (sql.includes("WITH wall_clock")) return { rows: [{ turnLeaseValid: true, parentLeaseValid: true }] }
    if (sql.includes('SELECT "id" FROM "agent_steps"')) return { rows: [{ id: "step-1" }] }
    if (sql.includes('SELECT step."ordinal"')) return { rows: [{ ordinal: 1, attempt: 2, status: stepStatus, taskId: "root-1" }] }
    if (sql.includes('SELECT turn."input"')) return { rows: [{ input: countryInput }] }
    throw new Error(`Unexpected query: ${sql}`)
  })
  return { client: { query } as unknown as Pick<pg.PoolClient, "query">, query, statements }
}

describe("sponsorship final-answer current reader", () => {
  it("checks a streaming candidate Step inside the scope fence", async () => {
    const fixture = clientFor("streaming")
    const result = await readSponsorshipFinalAnswerWithClient(fixture.client, {
      scope, rootAttemptCount: 3, targetCountryCode: "IE", graphBinding, expectedStepStatus: "streaming",
    })
    expect(result).toMatchObject({ rootTaskId: "root-1", candidateStepId: "step-1", targetCountryCode: "IE", outcomes: [] })
    expect(fixture.statements.some(sql => sql.includes('SELECT "id" FROM "agent_steps"') && sql.includes('"status" = \'streaming\''))).toBe(true)
    expect(controls.read).toHaveBeenCalled()
  })

  it("locks Root/Turn first, then validates the already-completed Step exactly", async () => {
    const fixture = clientFor("completed")
    const result = await readSponsorshipFinalAnswerWithClient(fixture.client, {
      scope, rootAttemptCount: 3, targetCountryCode: "IE", graphBinding, expectedStepStatus: "completed",
    })
    expect(result).toMatchObject({ rootTaskId: "root-1", candidateStepId: "step-1", targetCountryCode: "IE", outcomes: [] })
    expect(fixture.statements.some(sql => sql.includes('SELECT "id" FROM "agent_steps"'))).toBe(false)
    const rootIndex = fixture.statements.findIndex(sql => sql.includes('SELECT task.*'))
    const stepIndex = fixture.statements.findIndex(sql => sql.includes('SELECT step."ordinal"'))
    expect(rootIndex).toBeGreaterThan(-1)
    expect(stepIndex).toBeGreaterThan(rootIndex)
    expect(fixture.statements[stepIndex]).toContain('step."status" = $8')
  })

  it("fails closed on a changed country, Root attempt, or Step status", async () => {
    const wrongCountry = clientFor("streaming")
    wrongCountry.query.mockImplementation(async sql => {
      wrongCountry.statements.push(sql.replace(/\s+/gu, " ").trim())
      if (sql.includes('SELECT turn."input"')) return { rows: [{ input: { ...countryInput,
        sponsorshipTargetCountry: { ...countryInput.sponsorshipTargetCountry, countryCode: "US" } } }] }
      if (sql.includes("set_config")) return { rows: [] }
      if (sql.includes('SELECT "id" FROM "agent_sessions"')) return { rows: [{ id: "session-1" }] }
      if (sql.includes('SELECT "id" FROM "agent_turns"')) return { rows: [{ id: "turn-1" }] }
      if (sql.includes('SELECT task.*')) return { rows: [{ id: "root-1" }] }
      if (sql.includes("WITH wall_clock")) return { rows: [{ turnLeaseValid: true, parentLeaseValid: true }] }
      if (sql.includes('SELECT "id" FROM "agent_steps"')) return { rows: [{ id: "step-1" }] }
      if (sql.includes('SELECT step."ordinal"')) return { rows: [{ ordinal: 1, attempt: 2, status: "streaming", taskId: "root-1" }] }
      throw new Error(`Unexpected query: ${sql}`)
    })
    await expect(readSponsorshipFinalAnswerWithClient(wrongCountry.client, {
      scope, rootAttemptCount: 3, targetCountryCode: "IE", graphBinding, expectedStepStatus: "streaming",
    })).resolves.toBeUndefined()

    const wrongAttempt = clientFor("streaming")
    await expect(readSponsorshipFinalAnswerWithClient(wrongAttempt.client, {
      scope: { ...scope, parentAttemptCount: 4 }, rootAttemptCount: 3, targetCountryCode: "IE", graphBinding, expectedStepStatus: "streaming",
    })).resolves.toBeUndefined()

    const wrongStep = clientFor("failed")
    await expect(readSponsorshipFinalAnswerWithClient(wrongStep.client, {
      scope, rootAttemptCount: 3, targetCountryCode: "IE", graphBinding, expectedStepStatus: "streaming",
    })).resolves.toBeUndefined()
  })
})
