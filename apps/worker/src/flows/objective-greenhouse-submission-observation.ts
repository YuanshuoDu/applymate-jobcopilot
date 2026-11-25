import type { Frame, Page, Request, Response } from "playwright-core"
import { assertSubmissionAuthorized, type SubmissionGuard } from "./helpers.js"
import { matchesSubmissionRequest, readSubmissionRequestIntent, type SubmissionRequestIntent } from "./submission-intent.js"

export const OBJECTIVE_SUBMISSION_START_TIMEOUT_MS = 8_000
export const OBJECTIVE_SUBMISSION_FORWARD_TIMEOUT_MS = OBJECTIVE_SUBMISSION_START_TIMEOUT_MS + 1_000
export const OBJECTIVE_SUBMISSION_CONFIRMATION_TIMEOUT_MS = 20_000

export type ObjectiveSubmissionObservationOutcome =
  | "confirmed" | "no_request" | "wrong_provenance" | "intent_mismatch" | "not_forwarded" | "forward_uncertain" | "click_error"
  | "request_failed" | "response_missing" | "response_mismatch" | "response_rejected"
  | "navigation_missing" | "confirmation_missing" | "cancelled" | "not_armed"

export type ObjectiveGreenhouseSubmissionObservation = Readonly<{
  arm(intent: SubmissionRequestIntent): boolean
  accept(request: Request): boolean
  reject(reason: "wrong_provenance" | "intent_mismatch" | "not_forwarded" | "forward_uncertain" | "click_error"): void
  forward(request: Request): boolean
  waitForConfirmation(): Promise<ObjectiveSubmissionObservationOutcome>
  outcome(): ObjectiveSubmissionObservationOutcome | null
  dispose(): void
}>

export function createObjectiveGreenhouseSubmissionObservation(
  page: Page,
  getSignal: () => AbortSignal | null,
): ObjectiveGreenhouseSubmissionObservation {
  let phase: "idle" | "armed" | "accepted" | "forwarded" | "done" = "idle"
  let intent: SubmissionRequestIntent | null = null
  let preSubmitUrl: string | null = null
  let mainFrame: Frame | null = null
  let accepted: Request | null = null
  let exactResponse: Response | null = null
  let navigationResponse: Response | null = null
  let committedDocumentUrl: string | null = null
  let unrelatedNavigationResponse = false
  let result: ObjectiveSubmissionObservationOutcome | null = null
  let deadline: ReturnType<typeof setTimeout> | undefined
  let poll: ReturnType<typeof setTimeout> | undefined
  let checking = false
  let resolveResult!: (value: ObjectiveSubmissionObservationOutcome) => void
  const finished = new Promise<ObjectiveSubmissionObservationOutcome>(resolve => { resolveResult = resolve })
  let abortSignal: AbortSignal | null = null
  let attached = false

  const detach = () => {
    if (deadline) clearTimeout(deadline)
    if (poll) clearTimeout(poll)
    deadline = poll = undefined
    if (attached) {
      page.off("response", onResponse)
      page.off("framenavigated", onFrameNavigated)
      page.off("requestfailed", onRequestFailed)
      attached = false
    }
    abortSignal?.removeEventListener("abort", onAbort)
    abortSignal = null
  }
  const finish = (outcome: ObjectiveSubmissionObservationOutcome) => {
    if (result) return
    phase = "done"
    result = outcome
    detach()
    resolveResult(outcome)
  }
  const onAbort = () => finish("cancelled")
  const scheduleCheck = () => {
    if (phase !== "forwarded" || checking || poll) return
    poll = setTimeout(() => {
      poll = undefined
      void settleIfReady().catch(() => finish("confirmation_missing"))
    }, 50)
    poll.unref?.()
  }
  const onResponse = (response: Response) => {
    if (!accepted || phase === "done") return
    let request: Request
    try { request = response.request() } catch { return }
    try {
      const navigation = request.isNavigationRequest()
      const mainFrameResponse = navigation && response.frame() === mainFrame
      if (request === accepted) exactResponse = response
      if (mainFrameResponse) {
        if (belongsTo(request, accepted)) {
          const status = response.status()
          if (status < 300 || status >= 400) navigationResponse = response
        }
        else unrelatedNavigationResponse = true
      }
      scheduleCheck()
    } catch {
      if (request === accepted) finish("response_mismatch")
    }
  }
  const onFrameNavigated = (frame: Frame) => {
    if (!accepted || frame !== mainFrame || phase === "done") return
    try {
      committedDocumentUrl = frame.url()
      scheduleCheck()
    } catch { finish("response_mismatch") }
  }
  const onRequestFailed = (request: Request) => {
    if (!accepted || phase === "done") return
    try {
      if (belongsTo(request, accepted)) finish(phase === "forwarded" ? "request_failed" : "not_forwarded")
    } catch { if (request === accepted) finish("response_mismatch") }
  }
  const settleIfReady = async () => {
    if (phase !== "forwarded" || checking || !accepted || !exactResponse || !committedDocumentUrl) return
    checking = true
    try {
      if (unrelatedNavigationResponse) return finish("response_mismatch")
      if (!navigationResponse) return
      let responseUrl: string
      let submittedStatus: number
      let documentStatus: number
      try {
        responseUrl = navigationResponse.url()
        submittedStatus = exactResponse.status()
        documentStatus = navigationResponse.status()
        if (!belongsTo(navigationResponse.request(), accepted) || committedDocumentUrl !== responseUrl) {
          return finish("response_mismatch")
        }
      } catch { return finish("response_mismatch") }
      if (submittedStatus < 200 || submittedStatus >= 400 || documentStatus < 200 || documentStatus >= 300) {
        return finish("response_rejected")
      }
      try {
        const currentUrl = page.url()
        if (currentUrl !== committedDocumentUrl) return finish("response_mismatch")
        const title = await page.title()
        if (page.url() !== currentUrl || committedDocumentUrl !== responseUrl) return finish("response_mismatch")
        const titleConfirms = /thank|success|confirmation|submitted|application.*received/i.test(title)
        const changedUrlConfirms = currentUrl !== preSubmitUrl
          && /thank|success|confirmation|submitted|application.*received/i.test(currentUrl)
        if (titleConfirms || changedUrlConfirms) {
          return finish("confirmed")
        }
      } catch { return finish("confirmation_missing") }
    } finally {
      checking = false
      if (phase === "forwarded" && exactResponse && navigationResponse && committedDocumentUrl) scheduleCheck()
    }
  }
  return {
    arm(value) {
      if (phase !== "idle" || !matchesSubmissionRequest(value, { url: () => value.url, method: () => value.method })) {
        finish("not_armed")
        return false
      }
      try {
        abortSignal = getSignal()
        if (!abortSignal || abortSignal.aborted) { finish("not_armed"); return false }
        preSubmitUrl = page.url()
        mainFrame = page.mainFrame()
        intent = { url: value.url, method: value.method }
        phase = "armed"
        attached = true
        page.on("response", onResponse)
        page.on("framenavigated", onFrameNavigated)
        page.on("requestfailed", onRequestFailed)
        abortSignal.addEventListener("abort", onAbort, { once: true })
        deadline = setTimeout(() => finish("no_request"), OBJECTIVE_SUBMISSION_START_TIMEOUT_MS)
        deadline.unref?.()
        return true
      } catch { finish("not_armed"); return false }
    },
    accept(request) {
      if (phase !== "armed" || !intent || !mainFrame) {
        if (phase === "idle") finish("not_armed")
        return false
      }
      let valid = false
      try { valid = request.frame() === mainFrame && request.isNavigationRequest() && matchesSubmissionRequest(intent, request) }
      catch { valid = false }
      if (!valid) { finish("wrong_provenance"); return false }
      accepted = request
      phase = "accepted"
      if (deadline) clearTimeout(deadline)
      deadline = setTimeout(() => finish("not_forwarded"), OBJECTIVE_SUBMISSION_FORWARD_TIMEOUT_MS)
      deadline.unref?.()
      return true
    },
    reject(reason) { if (phase === "armed" || phase === "accepted") finish(reason) },
    forward(request) {
      if (phase !== "accepted" || accepted !== request) return false
      phase = "forwarded"
      if (deadline) clearTimeout(deadline)
      deadline = setTimeout(() => finish(!exactResponse ? "response_missing" : !navigationResponse || !committedDocumentUrl ? "navigation_missing" : "confirmation_missing"), OBJECTIVE_SUBMISSION_CONFIRMATION_TIMEOUT_MS)
      deadline.unref?.()
      scheduleCheck()
      return true
    },
    waitForConfirmation: () => finished,
    outcome: () => result,
    dispose() { if (!result) finish("cancelled"); else detach() },
  }
}

export async function clickObjectiveSubmitOnce(
  page: Page,
  selectors: readonly string[],
  guard: SubmissionGuard | undefined,
  observation: ObjectiveGreenhouseSubmissionObservation,
): Promise<"clicked" | "missing" | "blocked" | "click_error" | "observer_unavailable"> {
  for (const selector of selectors) {
    let button: ReturnType<Page["locator"]>
    try {
      button = page.locator(selector).first()
      if (!(await button.count()) || !(await button.isVisible().catch(() => false))) continue
    } catch { continue }
    const requestIntent = await readSubmissionRequestIntent(page, button)
    if (!requestIntent) continue
    if (!(await assertSubmissionAuthorized(guard, requestIntent)).authorized) return "blocked"
    if (!observation.arm(requestIntent)) return "observer_unavailable"
    try {
      await button.click({ noWaitAfter: true, timeout: OBJECTIVE_SUBMISSION_START_TIMEOUT_MS })
      return "clicked"
    } catch {
      observation.reject("click_error")
      return "click_error"
    }
  }
  return "missing"
}

function belongsTo(request: Request, accepted: Request): boolean {
  let current: Request | null = request
  for (let count = 0; current && count < 12; count++) {
    if (current === accepted) return true
    current = current.redirectedFrom()
  }
  return false
}
