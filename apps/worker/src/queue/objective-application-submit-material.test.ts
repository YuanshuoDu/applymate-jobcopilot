import { existsSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApplyTask, HarnessResult } from "../harness/agent-harness.js"
import type { Page } from "playwright-core"
import type { ObjectiveGreenhouseSubmissionObservation } from "../flows/objective-greenhouse-submission-observation.js"

const mocks = vi.hoisted(() => ({ generate: vi.fn(), greenhouse: vi.fn() }))
vi.mock("../db/resume-pdf.js", () => ({ generateResumePdf: mocks.generate }))
vi.mock("../flows/greenhouse-flow.js", () => ({ runGreenhouseFlow: mocks.greenhouse }))
import { objectiveApplicationSubmitTargetSupported, runObjectiveGreenhouseApplicationSubmit } from "./objective-application-submit-material.js"

const directUrl = "https://boards.greenhouse.io/acme/jobs/123"
const resume = { basics: { name: "Approved candidate" }, experience: [{ company: "Example" }] }
const material = { reviewedResumeContent: resume, reviewedCoverLetter: "Approved letter", confirmedAnswers: { salary: "€80,000" }, approvedApplyUrl: directUrl }
const page = { url: () => `${directUrl}/application` } as Page
const observation = {
  arm: vi.fn().mockReturnValue(true), accept: vi.fn().mockReturnValue(true), reject: vi.fn(),
  forward: vi.fn().mockReturnValue(true), waitForConfirmation: vi.fn().mockResolvedValue("confirmed"),
  outcome: vi.fn().mockReturnValue("confirmed"), dispose: vi.fn(),
} as unknown as ObjectiveGreenhouseSubmissionObservation
const task: ApplyTask = { jobId: "job-1", applyUrl: directUrl, persona: { fullName: "Candidate", coverLetter: "Old letter" },
  jobTitle: "Engineer", jobCompany: "Example", resumePath: "/old/resume.pdf", coverLetterPath: "/old/letter.pdf",
  confirmedAnswers: { old: "stale" }, allowSubmit: true, beforeSubmit: vi.fn().mockResolvedValue(true) }
let generatedPath = ""

beforeEach(() => {
  vi.clearAllMocks()
  generatedPath = ""
  mocks.generate.mockImplementation(async (ownerId: string) => {
    generatedPath = join(tmpdir(), `resume-${ownerId}-123.pdf`)
    writeFileSync(generatedPath, "approved pdf")
    return generatedPath
  })
  mocks.greenhouse.mockResolvedValue({ status: "submitted", durationMs: 1 } satisfies HarnessResult)
})

afterEach(() => { if (generatedPath && existsSync(generatedPath)) unlinkSync(generatedPath) })

describe("Objective approved Greenhouse submit material", () => {
  it("supports only HTTPS Greenhouse direct and single-segment short links", () => {
    expect(objectiveApplicationSubmitTargetSupported(directUrl)).toBe(true)
    expect(objectiveApplicationSubmitTargetSupported(`${directUrl}/applications/new?gh_src=source`)).toBe(true)
    expect(objectiveApplicationSubmitTargetSupported("http://boards.greenhouse.io/acme/jobs/123")).toBe(false)
    expect(objectiveApplicationSubmitTargetSupported("https://user@boards.greenhouse.io/acme/jobs/123")).toBe(false)
    expect(objectiveApplicationSubmitTargetSupported("https://grnh.se/abc123")).toBe(false)
    expect(objectiveApplicationSubmitTargetSupported("https://job-boards.greenhouse.io/embed/job_app?for=acme")).toBe(false)
    expect(objectiveApplicationSubmitTargetSupported(`${directUrl}/application/other`)).toBe(false)
    expect(objectiveApplicationSubmitTargetSupported("https://jobs.lever.co/acme/123")).toBe(false)
  })

  it("renders and submits only the exact approved Resume, letter, answers, and URL", async () => {
    const result = await runObjectiveGreenhouseApplicationSubmit({ userId: "user-1", task, material, page, observation })
    const [actualPage, actualTask, options] = mocks.greenhouse.mock.calls[0] ?? []

    expect(result.status).toBe("submitted")
    expect(mocks.generate).toHaveBeenCalledWith(expect.stringMatching(/^objective-[0-9a-f-]+$/), resume)
    expect(actualPage).toBe(page)
    expect(actualTask).toMatchObject({ applyUrl: directUrl, resumePath: generatedPath, allowSubmit: true,
      confirmedAnswers: { salary: "€80,000" }, persona: { coverLetter: "Approved letter" } })
    expect(actualTask.coverLetterPath).toBeUndefined()
    expect(actualTask.beforeSubmit).toBe(task.beforeSubmit)
    expect(options).toEqual({ reviewedCoverLetter: "Approved letter", objectiveReviewedSubmission: true, submissionObservation: observation })
    expect(existsSync(generatedPath)).toBe(false)
  })

  it("preserves special confirmed-answer keys as data", async () => {
    const answers = Object.create(null) as Record<string, string>
    answers["__proto__"] = "confirmed value"
    await runObjectiveGreenhouseApplicationSubmit({ userId: "user-1", task, material: { ...material, confirmedAnswers: answers }, page, observation })
    const submittedTask = mocks.greenhouse.mock.calls[0]?.[1] as ApplyTask
    expect(Object.hasOwn(submittedTask.confirmedAnswers ?? {}, "__proto__")).toBe(true)
    expect(submittedTask.confirmedAnswers?.["__proto__"]).toBe("confirmed value")
  })

  it.each([
    ["extra packet key", { ...material, extra: "not allowed" }, task, page],
    ["accessor packet value", accessorMaterial(), task, page],
    ["empty Resume", { ...material, reviewedResumeContent: {} }, task, page],
    ["empty confirmed answer", { ...material, confirmedAnswers: { salary: " " } }, task, page],
    ["mismatched URL", material, { ...task, applyUrl: "https://boards.greenhouse.io/acme/jobs/other" }, page],
    ["unsupported approved URL", { ...material, approvedApplyUrl: "https://jobs.lever.co/acme/123" }, task, page],
    ["wrong live page", material, task, { url: () => "https://jobs.lever.co/acme/123" } as Page],
    ["sibling Greenhouse job page", material, task, { url: () => "https://boards.greenhouse.io/acme/jobs/124/application" } as Page],
    ["missing submit guard", material, { ...task, beforeSubmit: undefined }, page],
    ["submit permission disabled", material, { ...task, allowSubmit: false }, page],
  ])("fails closed for %s without PDF generation or browser work", async (_name, candidate, candidateTask, candidatePage) => {
    const result = await runObjectiveGreenhouseApplicationSubmit({ userId: "user-1", task: candidateTask, material: candidate, page: candidatePage })
    expect(result.status).toBe("submission_blocked")
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.greenhouse).not.toHaveBeenCalled()
  })

  it("does not generate or submit on the existing dry-run task", async () => {
    const result = await runObjectiveGreenhouseApplicationSubmit({ userId: "user-1", task: { ...task, dryRun: true }, material, page })
    expect(result.status).toBe("dry-run")
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.greenhouse).not.toHaveBeenCalled()
  })

  it("requires an observation before rendering approved material for a real submit", async () => {
    const result = await runObjectiveGreenhouseApplicationSubmit({ userId: "user-1", task, material, page })

    expect(result.status).toBe("submission_blocked")
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.greenhouse).not.toHaveBeenCalled()
  })

  it("deletes the generated approved Resume when the dedicated flow throws", async () => {
    mocks.greenhouse.mockRejectedValueOnce(new Error("private browser detail"))
    await expect(runObjectiveGreenhouseApplicationSubmit({ userId: "user-1", task, material, page, observation }))
      .rejects.toThrow("private browser detail")
    expect(existsSync(generatedPath)).toBe(false)
  })

  it("cleans a partial PDF when rendering fails", async () => {
    mocks.generate.mockImplementationOnce(async (ownerId: string) => {
      generatedPath = join(tmpdir(), `resume-${ownerId}-123.pdf`)
      writeFileSync(generatedPath, "partial pdf")
      throw new Error("renderer failed")
    })
    await expect(runObjectiveGreenhouseApplicationSubmit({ userId: "user-1", task, material, page, observation }))
      .resolves.toMatchObject({ status: "submission_blocked" })
    expect(existsSync(generatedPath)).toBe(false)
    expect(mocks.greenhouse).not.toHaveBeenCalled()
  })
})

function accessorMaterial(): unknown {
  const value = { ...material } as Record<string, unknown>
  Object.defineProperty(value, "reviewedCoverLetter", { enumerable: true, get() { throw new Error("not read") } })
  return value
}
