import type { Page } from "playwright-core"
import { detectAtsSource } from "@jobcopilot/shared/ats-url"
import { randomUUID } from "node:crypto"
import { readdirSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { generateResumePdf, type ResumeContent } from "../db/resume-pdf.js"
import type { ApplyTask, HarnessResult } from "../harness/agent-harness.js"
import { runGreenhouseFlow } from "../flows/greenhouse-flow.js"

export type ObjectiveApplicationSubmitMaterial = Readonly<{
  reviewedResumeContent: unknown
  reviewedCoverLetter: string
  confirmedAnswers: Readonly<Record<string, string>>
  approvedApplyUrl: string
}>

type SubmitInput = Readonly<{ userId: string; task: ApplyTask; material: unknown; page: Page }>
const MATERIAL_KEYS = ["approvedApplyUrl", "confirmedAnswers", "reviewedCoverLetter", "reviewedResumeContent"]
const MAX_JSON_NODES = 10_000

export function objectiveApplicationSubmitTargetSupported(value: unknown): boolean {
  return greenhouseJobIdentity(value) !== null
}

export async function runObjectiveGreenhouseApplicationSubmit(input: SubmitInput): Promise<HarnessResult> {
  const startedAt = Date.now()
  const material = parseMaterialSafely(input.material)
  if (!material || !safeId(input.userId) || !safeId(input.task.jobId)
    || input.task.applyUrl !== material.approvedApplyUrl || input.task.allowSubmit !== true
    || typeof input.task.beforeSubmit !== "function" || !objectiveApplicationSubmitTargetSupported(material.approvedApplyUrl)
    || greenhouseJobIdentity(input.task.applyUrl) !== greenhouseJobIdentity(material.approvedApplyUrl)
    || liveGreenhouseTarget(input.page) !== greenhouseJobIdentity(material.approvedApplyUrl)) return unavailable(startedAt)
  if (input.task.dryRun) return { status: "dry-run", durationMs: Date.now() - startedAt, turns: 1, log: [] }

  const pdfOwnerId = `objective-${randomUUID()}`
  let resumePath: string
  try {
    resumePath = await generateResumePdf(pdfOwnerId, material.reviewedResumeContent as ResumeContent)
  } catch {
    cleanupGeneratedResume(pdfOwnerId)
    return unavailable(startedAt)
  }
  try {
    const task: ApplyTask = {
      ...input.task,
      applyUrl: material.approvedApplyUrl,
      resumePath,
      coverLetterPath: undefined,
      persona: { ...input.task.persona, coverLetter: material.reviewedCoverLetter },
      confirmedAnswers: Object.assign(Object.create(null) as Record<string, string>, material.confirmedAnswers),
      allowSubmit: true,
    }
    return await runGreenhouseFlow(input.page, task, {
      reviewedCoverLetter: material.reviewedCoverLetter,
      objectiveReviewedSubmission: true,
    })
  } finally {
    cleanupGeneratedResume(pdfOwnerId)
  }
}

function parseMaterialSafely(value: unknown): ObjectiveApplicationSubmitMaterial | null {
  try { return parseMaterial(value) } catch { return null }
}

function parseMaterial(value: unknown): ObjectiveApplicationSubmitMaterial | null {
  if (!plainRecord(value) || !exactKeys(value, MATERIAL_KEYS)) return null
  const resume = dataValue(value, "reviewedResumeContent")
  const letter = dataValue(value, "reviewedCoverLetter")
  const answers = dataValue(value, "confirmedAnswers")
  const url = dataValue(value, "approvedApplyUrl")
  const parsedAnswers = parseAnswers(answers)
  if (!isNonemptyJsonRecord(resume) || typeof letter !== "string" || !letter.trim() || letter.length > 2000
    || !parsedAnswers || typeof url !== "string" || !objectiveApplicationSubmitTargetSupported(url)) return null
  return { reviewedResumeContent: resume, reviewedCoverLetter: letter,
    confirmedAnswers: parsedAnswers, approvedApplyUrl: url }
}

function parseAnswers(value: unknown): Record<string, string> | null {
  if (!plainRecord(value) || Reflect.ownKeys(value).length > 65) return null
  const answers = Object.create(null) as Record<string, string>
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return null
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable
      || !key.trim() || key.length > 256 || typeof descriptor.value !== "string"
      || !descriptor.value.trim() || descriptor.value.length > 2000) return null
    answers[key] = descriptor.value
  }
  return answers
}

function isNonemptyJsonRecord(value: unknown): value is Record<string, unknown> {
  if (!plainRecord(value) || Reflect.ownKeys(value).length === 0) return false
  const budget = { nodes: 0, chars: 0 }
  return jsonValue(value, 0, budget) && budget.chars <= 500_000 && containsText(value)
}

function containsText(value: unknown): boolean {
  if (typeof value === "string") return Boolean(value.trim())
  if (Array.isArray(value)) return value.some(containsText)
  if (plainRecord(value)) return Object.values(value).some(containsText)
  return false
}

function jsonValue(value: unknown, depth: number, budget: { nodes: number; chars: number }): boolean {
  if (++budget.nodes > MAX_JSON_NODES || depth > 16) return false
  if (value === null || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value === "string") { budget.chars += value.length; return value.length <= 50_000 }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) return false
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || !jsonValue(descriptor.value, depth + 1, budget)) return false
    }
    return true
  }
  if (!plainRecord(value)) return false
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return false
    budget.chars += key.length
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable
      || !jsonValue(descriptor.value, depth + 1, budget)) return false
  }
  return true
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.length && keys.every(key => typeof key === "string" && expected.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"))
}

function dataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)
}

function liveGreenhouseTarget(page: Page): string | null {
  try { return greenhouseJobIdentity(page.url()) } catch { return null }
}

function greenhouseJobIdentity(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.username || url.password || url.port || detectAtsSource(value) !== "greenhouse") return null
    const host = url.hostname.toLowerCase()
    const segments = url.pathname.split("/").filter(Boolean)
    let board: string, jobId: string, suffix: string[]
    if (host === "boards.greenhouse.io" && segments[1] === "jobs") {
      board = segments[0] ?? ""
      jobId = segments[2] ?? ""
      suffix = segments.slice(3)
    } else if (host.endsWith(".greenhouse.io") && host !== "boards.greenhouse.io" && !host.startsWith("job-boards.") && segments[0] === "jobs") {
      board = host
      jobId = segments[1] ?? ""
      suffix = segments.slice(2)
    } else return null
    const suffixPath = suffix.join("/")
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(board) || !/^[A-Za-z0-9_-]{1,128}$/.test(jobId)
      || (suffix.length > 0 && !["application", "application/new", "applications/new", "apply"].includes(suffixPath))) return null
    return `${host}/${board}/jobs/${jobId}`
  } catch { return null }
}

function cleanupGeneratedResume(ownerId: string): void {
  const prefix = `resume-${ownerId}-`
  try {
    for (const name of readdirSync(tmpdir())) {
      if (name.startsWith(prefix) && name.endsWith(".pdf")) {
        try { unlinkSync(join(tmpdir(), name)) } catch { /* best-effort cleanup */ }
      }
    }
  } catch { /* best-effort cleanup */ }
}

function unavailable(startedAt: number): HarnessResult {
  return { status: "submission_blocked", error: "Approved Objective application material is unavailable.", durationMs: Date.now() - startedAt, log: [] }
}
