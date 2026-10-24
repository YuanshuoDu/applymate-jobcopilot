import { describe, expect, it, vi } from "vitest"
import {
  createScheduledTaskGraphGateQuestion,
  executeScheduledTaskGraphGate,
  parseScheduledTaskGraphGateChoiceHistory,
  parseScheduledTaskGraphGateChoice,
  parseScheduledTaskGraphGateResult,
} from "./scheduled-taskgraph-gate-service"
import type { ScheduledTaskGraphGateHandoff } from "./scheduled-taskgraph-gate-checkpoint"
import type { PipelineCtx } from "./pipeline-context"
import type { ApplicationPackage } from "./types"

const jobIds = ["job_1", "job_2", "job_3"]
function gateInput(): { handoff: ScheduledTaskGraphGateHandoff; context: PipelineCtx } {
  const packages = jobIds.map((id, index) => ({ job: { id, company: "Private company", description: "Private JD" }, score: 80 + index,
    matchedKeywords: [], missingKeywords: [], recommendation: "Private recommendation", coverLetter: "Private material" } as unknown as ApplicationPackage))
  return { handoff: { checkpoint: { nextStage: "gate" }, packages } as unknown as ScheduledTaskGraphGateHandoff,
    context: { agentCfg: { minMatchScore: 70 } } as PipelineCtx }
}

describe("scheduled TaskGraph Gate result boundary", () => {
  it("creates bounded fixed-choice questions with a canonical candidate identity", () => {
    const first = createScheduledTaskGraphGateQuestion("borderline_match", ["job_2", "job_1"])
    const reordered = createScheduledTaskGraphGateQuestion("borderline_match", ["job_1", "job_2"])

    expect(first).toEqual({ status: "question_required", kind: "borderline_match", jobIds: ["job_2", "job_1"],
      candidateSetDigest: reordered?.candidateSetDigest,
      allowedChoiceIds: ["add_to_pending", "skip", "lower_threshold"] })
    expect(createScheduledTaskGraphGateQuestion("weak_cover_letter", ["job_1", "job_2"])).toBeNull()
    expect(createScheduledTaskGraphGateQuestion("weak_cover_letter", ["job_1"])?.allowedChoiceIds)
      .toEqual(["continue", "review", "skip"])
    expect(createScheduledTaskGraphGateQuestion("borderline_match", ["job_1", "job_1"])).toBeNull()
    expect(createScheduledTaskGraphGateQuestion("borderline_match", Array.from({ length: 51 }, (_, i) => `job_${i}`))).toBeNull()
  })

  it("accepts only the complete recomputed candidate set and fixed choices", () => {
    const question = createScheduledTaskGraphGateQuestion("borderline_match", ["job_1", "job_2"])!
    const expected = { kind: question.kind, jobIds: question.jobIds }
    expect(parseScheduledTaskGraphGateResult(question, jobIds, expected)).toEqual(question)
    expect(parseScheduledTaskGraphGateResult(question, jobIds)).toBeNull()
    expect(parseScheduledTaskGraphGateResult({ ...question, jobIds: ["job_1"] }, jobIds, expected)).toBeNull()
    expect(parseScheduledTaskGraphGateResult({ ...question, jobIds: ["job_1", "other"] }, jobIds, expected)).toBeNull()
    expect(parseScheduledTaskGraphGateResult({ ...question, extra: "private material" }, jobIds, expected)).toBeNull()
    expect(parseScheduledTaskGraphGateResult({ ...question, allowedChoiceIds: ["add_to_pending", "skip"] }, jobIds, expected)).toBeNull()

    expect(parseScheduledTaskGraphGateChoice({ kind: question.kind, jobIds: ["job_2", "job_1"], choiceId: "lower_threshold" }, question)).toBe("lower_threshold")
    expect(parseScheduledTaskGraphGateChoice({ kind: question.kind, jobIds: ["job_1"], choiceId: "skip" }, question)).toBeNull()
    expect(parseScheduledTaskGraphGateChoice({ kind: "weak_cover_letter", jobIds: question.jobIds, choiceId: "skip" }, question)).toBeNull()
    expect(parseScheduledTaskGraphGateChoice({ kind: question.kind, jobIds: question.jobIds, choiceId: "continue" }, question)).toBeNull()
    expect(parseScheduledTaskGraphGateChoice({ kind: question.kind, jobIds: question.jobIds, choiceId: "skip", privateBinding: "secret" }, question)).toBeNull()
  })

  it("accepts exact ordered prior decisions and rejects malformed, duplicate, or mismatched history", () => {
    const prior = { kind: "weak_cover_letter", jobIds: ["job_1"], choiceId: "skip" }
    const current = { kind: "weak_cover_letter", jobIds: ["job_2"], choiceId: "review" }
    const expected = { kind: "borderline_match" as const, jobIds: ["job_3"] }
    expect(parseScheduledTaskGraphGateChoiceHistory([prior], current, jobIds, expected)).toEqual({
      priorChoices: [prior], currentChoice: current,
    })
    expect(parseScheduledTaskGraphGateChoiceHistory([prior, { ...prior }], current, jobIds, expected)).toBeNull()
    expect(parseScheduledTaskGraphGateChoiceHistory([{ ...prior, jobIds: ["unknown"] }], current, jobIds, expected)).toBeNull()
    expect(parseScheduledTaskGraphGateChoiceHistory([{ ...prior, privateBinding: "secret" }], current, jobIds, expected)).toBeNull()
    expect(parseScheduledTaskGraphGateChoiceHistory([prior], { ...prior, choiceId: "review" }, jobIds, expected)).toBeNull()
    const fiftyJobs = Array.from({ length: 50 }, (_, index) => `job_${index}`)
    const fullHistory = [{ kind: "borderline_match", jobIds: [fiftyJobs[0]], choiceId: "add_to_pending" },
      ...fiftyJobs.map(jobId => ({ kind: "weak_cover_letter", jobIds: [jobId], choiceId: "review" }))]
    expect(parseScheduledTaskGraphGateChoiceHistory(fullHistory, undefined, fiftyJobs,
      { kind: "borderline_match", jobIds: [fiftyJobs[0]!] })?.priorChoices).toHaveLength(51)
  })

  it("accepts a strict Execute checkpoint only when decisions partition every verified package", () => {
    const completion = { status: "completed", nextStage: "execute", approvedJobIds: [],
      pendingJobIds: ["job_1", "job_2"], skippedJobIds: ["job_3"], counts: { approved: 0, pending: 2, skipped: 1 } }
    expect(parseScheduledTaskGraphGateResult(completion, jobIds)).toEqual(completion)
    expect(parseScheduledTaskGraphGateResult({ ...completion, approvedJobIds: ["job_1"],
      pendingJobIds: ["job_2"], counts: { approved: 1, pending: 1, skipped: 1 } }, jobIds)).toBeNull()
    expect(parseScheduledTaskGraphGateResult({ ...completion, nextStage: "gate" }, jobIds)).toBeNull()
    expect(parseScheduledTaskGraphGateResult({ ...completion, pendingJobIds: ["job_1", "job_1", "job_2"] }, jobIds)).toBeNull()
    expect(parseScheduledTaskGraphGateResult({ ...completion, skippedJobIds: [] }, jobIds)).toBeNull()
    expect(parseScheduledTaskGraphGateResult({ ...completion, counts: { approved: 0, pending: 0, skipped: 3 } }, jobIds)).toBeNull()
    expect(parseScheduledTaskGraphGateResult({ ...completion, token: "claim" }, jobIds)).toBeNull()
  })

  it("projects only server-built decisions from the verified Gate handoff", async () => {
    const input = gateInput()
    const history = [{ kind: "weak_cover_letter", jobIds: ["job_1"], choiceId: "skip" }]
    const policy = async (packages: readonly ApplicationPackage[], context: PipelineCtx, choice?: unknown, prior?: readonly unknown[]) => {
      expect(packages).toBe(input.handoff.packages)
      expect(context).toBe(input.context)
      expect(choice).toEqual({ id: "worker-validated-choice" })
      expect(prior).toBe(history)
      return { status: "completed" as const, nextStage: "execute" as const,
        approvedJobIds: [], pendingJobIds: ["job_1", "job_2"], skippedJobIds: ["job_3"],
        counts: { approved: 0, pending: 2, skipped: 1 } }
    }

    await expect(executeScheduledTaskGraphGate({ ...input, validatedChoice: { id: "worker-validated-choice" }, priorChoices: history }, policy)).resolves.toEqual({
      status: "completed", nextStage: "execute", approvedJobIds: [], pendingJobIds: ["job_1", "job_2"],
      skippedJobIds: ["job_3"], counts: { approved: 0, pending: 2, skipped: 1 },
    })
  })

  it("accepts a weak-letter question only for one server-loaded package and suppresses askUser", async () => {
    const input = gateInput()
    const question = createScheduledTaskGraphGateQuestion("weak_cover_letter", ["job_1"])!
    const policy = async () => question
    await expect(executeScheduledTaskGraphGate(input, policy)).resolves.toEqual(question)

    await expect(executeScheduledTaskGraphGate({ ...input, context: { ...input.context, askUser: vi.fn() } }, policy))
      .rejects.toThrow("scheduled_taskgraph_gate_result_invalid")
  })

  it("rejects an incomplete borderline set and a result that leaks extra fields", async () => {
    const input = gateInput()
    const question = createScheduledTaskGraphGateQuestion("borderline_match", ["job_1", "job_2"])!
    const missingCandidate = { ...question, jobIds: ["job_1"] }
    await expect(executeScheduledTaskGraphGate(input, async () => missingCandidate)).rejects.toThrow("scheduled_taskgraph_gate_result_invalid")
    await expect(executeScheduledTaskGraphGate(input, async () => ({ ...question, privateBody: "secret" })))
      .rejects.toThrow("scheduled_taskgraph_gate_result_invalid")
  })
})
