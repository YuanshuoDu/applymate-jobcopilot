import { afterEach, describe, expect, it, vi } from "vitest"
import type { Frame, Page, Request, Response } from "playwright-core"
import { clickObjectiveSubmitOnce, createObjectiveGreenhouseSubmissionObservation, OBJECTIVE_SUBMISSION_CONFIRMATION_TIMEOUT_MS, OBJECTIVE_SUBMISSION_START_TIMEOUT_MS } from "./objective-greenhouse-submission-observation.js"

const action = "https://boards.greenhouse.io/acme/jobs/123/application"
const intent = { url: action, method: "POST" }

function fakePage() {
  const listeners = new Map<string, Set<(value: unknown) => void>>()
  let currentUrl = "https://boards.greenhouse.io/acme/jobs/123/application/new"
  let currentTitle = "Application"
  const frame = { page: () => page, url: () => currentUrl } as unknown as Frame
  const page = {
    mainFrame: () => frame,
    url: () => currentUrl,
    title: vi.fn(async () => currentTitle),
    on: vi.fn((event: string, listener: (value: unknown) => void) => {
      const eventListeners = listeners.get(event) ?? new Set()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
    }),
    off: vi.fn((event: string, listener: (value: unknown) => void) => listeners.get(event)?.delete(listener)),
    locator: vi.fn(),
  } as unknown as Page
  return {
    page, frame,
    setDocument(url: string, title = currentTitle) { currentUrl = url; currentTitle = title },
    emit(event: string, value: unknown) { for (const listener of listeners.get(event) ?? []) listener(value) },
  }
}

function request(page: ReturnType<typeof fakePage>, options: {
  url?: string; method?: string; navigation?: boolean; redirectedFrom?: Request | null;
} = {}): Request {
  return {
    url: () => options.url ?? action,
    method: () => options.method ?? "POST",
    isNavigationRequest: () => options.navigation ?? true,
    frame: () => page.frame,
    redirectedFrom: () => options.redirectedFrom ?? null,
  } as unknown as Request
}

function response(page: ReturnType<typeof fakePage>, req: Request, status: number, url = action): Response {
  return { request: () => req, status: () => status, url: () => url, frame: () => page.frame } as unknown as Response
}

function observer(page: ReturnType<typeof fakePage>) {
  const controller = new AbortController()
  return createObjectiveGreenhouseSubmissionObservation(page.page, () => controller.signal)
}

afterEach(() => vi.useRealTimers())

describe("Objective Greenhouse submit observation", () => {
  it("buffers the accepted response until its same-URL document commits and confirms", async () => {
    const fake = fakePage()
    fake.setDocument(action, "Application")
    const observation = observer(fake)
    const post = request(fake)
    const redirect = request(fake, { url: action, method: "GET", redirectedFrom: post })
    expect(observation.arm(intent)).toBe(true)
    expect(observation.accept(post)).toBe(true)
    expect(observation.forward(post)).toBe(true)
    fake.emit("response", response(fake, post, 302))
    fake.emit("response", response(fake, redirect, 200))
    expect(observation.outcome()).toBeNull()
    fake.setDocument(action, "Application submitted")
    fake.emit("framenavigated", fake.frame)
    await expect(observation.waitForConfirmation()).resolves.toBe("confirmed")
  })

  it("does not treat a success-like query on the unchanged form URL as confirmation", async () => {
    vi.useFakeTimers()
    const fake = fakePage()
    const successLikeUrl = `${action}?source=success-tracking`
    fake.setDocument(successLikeUrl, "Application")
    const observation = observer(fake)
    const post = request(fake, { url: successLikeUrl })
    expect(observation.arm({ url: successLikeUrl, method: "POST" })).toBe(true)
    expect(observation.accept(post)).toBe(true)
    expect(observation.forward(post)).toBe(true)
    fake.emit("response", response(fake, post, 200, successLikeUrl))
    fake.setDocument(successLikeUrl, "Application")
    fake.emit("framenavigated", fake.frame)
    await vi.advanceTimersByTimeAsync(OBJECTIVE_SUBMISSION_CONFIRMATION_TIMEOUT_MS)
    await expect(observation.waitForConfirmation()).resolves.toBe("confirmation_missing")
  })

  it("waits for the terminal redirect response when the document commits first", async () => {
    const fake = fakePage()
    const observation = observer(fake)
    const post = request(fake)
    const redirect = request(fake, { url: "https://boards.greenhouse.io/acme/jobs/123/confirmation", method: "GET", redirectedFrom: post })
    expect(observation.arm(intent)).toBe(true)
    expect(observation.accept(post)).toBe(true)
    expect(observation.forward(post)).toBe(true)
    fake.emit("response", response(fake, post, 302))
    fake.setDocument("https://boards.greenhouse.io/acme/jobs/123/confirmation", "Application submitted")
    fake.emit("framenavigated", fake.frame)
    expect(observation.outcome()).toBeNull()
    fake.emit("response", response(fake, redirect, 200, "https://boards.greenhouse.io/acme/jobs/123/confirmation"))
    await expect(observation.waitForConfirmation()).resolves.toBe("confirmed")
  })

  it("does not let an unrelated main-frame response certify the accepted POST", async () => {
    const fake = fakePage()
    const observation = observer(fake)
    const post = request(fake)
    const unrelated = request(fake, { url: "https://boards.greenhouse.io/acme/jobs/123/other", method: "GET" })
    expect(observation.arm(intent)).toBe(true)
    expect(observation.accept(post)).toBe(true)
    expect(observation.forward(post)).toBe(true)
    fake.emit("response", response(fake, post, 200))
    fake.emit("response", response(fake, unrelated, 200, "https://boards.greenhouse.io/acme/jobs/123/other"))
    fake.setDocument("https://boards.greenhouse.io/acme/jobs/123/other", "Application submitted")
    fake.emit("framenavigated", fake.frame)
    await expect(observation.waitForConfirmation()).resolves.toBe("response_mismatch")
  })

  it("ignores unrelated subresource reads while waiting for a valid confirmation title", async () => {
    const fake = fakePage()
    const observation = observer(fake)
    const post = request(fake)
    const read = request(fake, { url: "https://boards.greenhouse.io/assets/app.js", method: "GET", navigation: false })
    let titleReads = 0
    vi.mocked(fake.page.title).mockImplementation(async () => ++titleReads === 1 ? "Apply" : "Application received")
    expect(observation.arm(intent)).toBe(true)
    expect(observation.accept(post)).toBe(true)
    expect(observation.forward(post)).toBe(true)
    fake.emit("response", response(fake, read, 200, read.url()))
    fake.emit("response", response(fake, post, 200))
    fake.setDocument(action)
    fake.emit("framenavigated", fake.frame)
    await expect(observation.waitForConfirmation()).resolves.toBe("confirmed")
    expect(titleReads).toBeGreaterThan(1)
  })

  it("checks that the confirmation still belongs to the committed document after title reading", async () => {
    const fake = fakePage()
    const observation = observer(fake)
    const post = request(fake)
    let releaseTitle!: () => void
    vi.mocked(fake.page.title).mockImplementation(() => new Promise(resolve => { releaseTitle = () => resolve("Application submitted") }))
    expect(observation.arm(intent)).toBe(true)
    expect(observation.accept(post)).toBe(true)
    expect(observation.forward(post)).toBe(true)
    fake.emit("response", response(fake, post, 200))
    fake.setDocument(action)
    fake.emit("framenavigated", fake.frame)
    await vi.waitFor(() => expect(releaseTitle).toEqual(expect.any(Function)))
    fake.setDocument("https://boards.greenhouse.io/acme/jobs/123/unrelated")
    releaseTitle()
    await expect(observation.waitForConfirmation()).resolves.toBe("response_mismatch")
  })

  it("distinguishes no candidate from an accepted request that was never forwarded", async () => {
    vi.useFakeTimers()
    const noPage = fakePage()
    const noRequest = observer(noPage)
    expect(noRequest.arm(intent)).toBe(true)
    await vi.advanceTimersByTimeAsync(8_000)
    await expect(noRequest.waitForConfirmation()).resolves.toBe("no_request")

    const blockedPage = fakePage()
    const blocked = observer(blockedPage)
    expect(blocked.arm(intent)).toBe(true)
    expect(blocked.accept(request(blockedPage))).toBe(true)
    await vi.advanceTimersByTimeAsync(8_500)
    expect(blocked.outcome()).toBeNull()
    blocked.reject("not_forwarded")
    await expect(blocked.waitForConfirmation()).resolves.toBe("not_forwarded")

    const stalledPage = fakePage()
    const stalled = observer(stalledPage)
    expect(stalled.arm(intent)).toBe(true)
    expect(stalled.accept(request(stalledPage))).toBe(true)
    await vi.advanceTimersByTimeAsync(OBJECTIVE_SUBMISSION_START_TIMEOUT_MS + 1_000)
    await expect(stalled.waitForConfirmation()).resolves.toBe("not_forwarded")
  })

  it("records a failed accepted request without leaking the failure message", async () => {
    const fake = fakePage()
    const observation = observer(fake)
    const post = request(fake)
    expect(observation.arm(intent)).toBe(true)
    expect(observation.accept(post)).toBe(true)
    expect(observation.forward(post)).toBe(true)
    fake.emit("requestfailed", post)
    await expect(observation.waitForConfirmation()).resolves.toBe("request_failed")
  })

  it("clicks once only after guard and intent checks; a click error is terminal", async () => {
    const click = vi.fn().mockRejectedValue(new Error("private click detail"))
    const button = { first: () => button, count: async () => 1, isVisible: async () => true,
      evaluate: async () => intent, click }
    const page = { url: () => "https://boards.greenhouse.io/acme/jobs/123/application/new",
      locator: () => button } as unknown as Page
    const guard = vi.fn().mockResolvedValue(true)
    const observation = { arm: vi.fn().mockReturnValue(true), reject: vi.fn() } as unknown as ReturnType<typeof observer>

    await expect(clickObjectiveSubmitOnce(page, ["button[type=submit]", "#submit-app"], guard, observation))
      .resolves.toBe("click_error")
    expect(click).toHaveBeenCalledOnce()
    expect(guard).toHaveBeenCalledOnce()
    expect(observation.reject).toHaveBeenCalledWith("click_error")
  })
})
