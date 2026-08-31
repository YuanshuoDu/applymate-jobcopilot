import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { I18nProvider } from "@/lib/i18n"
import { TranscriptSpecialContent } from "./TranscriptSpecialBlocks"

describe("automation draft transcript block", () => {
  it("renders the preserved draft fields after the event is redacted", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <TranscriptSpecialContent
          border="#d9e2ec"
          event={{
            id: "event_1",
            taskId: null,
            type: "automation_draft",
            speaker: "Orchestrator",
            title: "Automation draft",
            body: "Review the automation before saving it.",
            data: {
              draft: {
                name: "Berlin SWE weekdays",
                triggerType: "weekdays",
                targetRoles: ["Software Engineer"],
                targetLocations: ["Berlin"],
                minScore: 85,
                requireApproval: true,
              },
              approval: { id: "approval_1", receiptNonce: "nonce_1" },
            },
            durationMs: null,
            createdAt: "2026-08-31T16:00:00.000Z",
          }}
        />
      </I18nProvider>,
    )

    expect(html).toContain("Berlin SWE weekdays")
    expect(html).toContain("weekdays")
    expect(html).toContain("Software Engineer · Berlin")
    expect(html).toContain("85+")
    expect(html).toContain("Create automation")
  })
})
