import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { ArtifactVersionCard } from "./ArtifactVersionCard"

describe("ArtifactVersionCard", () => {
  it("renders current version and hash", () => {
    const html = renderToStaticMarkup(<ArtifactVersionCard artifact={{ artifactId: "resume-job-1", version: 2, status: "current", hash: "sha256:abc" }} />)
    expect(html).toContain('data-artifact-status="current"')
    expect(html).toContain("Artifact v2")
    expect(html).toContain("sha256:abc")
  })

  it("makes stale status explicit", () => {
    const html = renderToStaticMarkup(<ArtifactVersionCard artifact={{ artifactId: "resume-job-1", version: 1, status: "stale" }} />)
    expect(html).toContain("must be reviewed again")
    expect(html).toContain('data-artifact-status="stale"')
  })

  it("exposes re-review only through the typed callback", () => {
    const onRequestReview = vi.fn()
    const html = renderToStaticMarkup(<ArtifactVersionCard artifact={{ artifactId: "resume-job-1", version: 1, status: "stale" }} onRequestReview={onRequestReview} />)
    expect(html).toContain("Request review")
    expect(onRequestReview).not.toHaveBeenCalled()
  })
})
