import { describe, it, expect, vi } from "vitest";
import { runLeverFlow } from "./lever-flow.js";
import type { Page } from "playwright-core";

function mockLeverPage(url = "https://jobs.lever.co/spotify/abc123/apply"): Page {
  return {
    url: () => url,
    title: () => Promise.resolve("Thank you for applying ? Spotify"),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        count: () => Promise.resolve(1),
        isVisible: () => Promise.resolve(true),
        click: vi.fn().mockResolvedValue(undefined),
        setInputFiles: vi.fn().mockResolvedValue(undefined),
      }),
      count: () => Promise.resolve(1),
      isVisible: () => Promise.resolve(true),
      click: vi.fn().mockResolvedValue(undefined),
      setInputFiles: vi.fn().mockResolvedValue(undefined),
    }),
    fill: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    $$: vi.fn().mockResolvedValue([{
      isVisible: () => Promise.resolve(true),
      inputValue: () => Promise.resolve(""),
      getAttribute: (attr: string) => Promise.resolve(attr === "name" ? "custom_field" : ""),
    }]),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

function mockLeverPageNoSubmit(url = "https://jobs.lever.co/klarna/xyz789/apply"): Page {
  const p = mockLeverPage(url);
  vi.mocked(p.locator).mockReturnValue({
    first: () => ({
      count: () => Promise.resolve(0),
      isVisible: () => Promise.resolve(false),
      click: vi.fn(),
      setInputFiles: vi.fn(),
    }),
    count: () => Promise.resolve(0),
    isVisible: () => Promise.resolve(false),
    click: vi.fn(),
    setInputFiles: vi.fn(),
  } as unknown as ReturnType<Page["locator"]>);
  return p;
}

describe("runLeverFlow", () => {
  it("dry-run returns immediately", async () => {
    const page = mockLeverPage();
    const result = await runLeverFlow(page, {
      jobId: "job-1",
      applyUrl: "https://jobs.lever.co/spotify/abc123/apply",
      persona: {
        fullName: "Jean Dupont",
        email: "jean@example.com",
        phone: "+33 6 12 34 56 78",
        linkedinUrl: "https://linkedin.com/in/jean",
        coverLetter: "I am excited to apply...",
      },
      jobTitle: "Engineer",
      jobCompany: "Spotify",
      resumePath: "/resume.pdf",
      dryRun: true,
    });

    expect(result.status).toBe("dry-run");
    expect(result.turns).toBe(1);
  });

  it("fills fields and submits", async () => {
    const page = mockLeverPage();
    const result = await runLeverFlow(page, {
      jobId: "job-2",
      applyUrl: "https://jobs.lever.co/spotify/abc123/apply",
      persona: {
        fullName: "Jean Dupont",
        email: "jean@example.com",
        phone: "+33 6 12 34 56 78",
        linkedinUrl: "https://linkedin.com/in/jean",
        coverLetter: "I am excited to apply...",
      },
      jobTitle: "Senior Engineer",
      jobCompany: "Spotify",
      resumePath: "/resume.pdf",
    });

    expect(result.status).toBe("submitted");
    expect(result.turns).toBe(1);
  });

  it("no submit button found", async () => {
    const page = mockLeverPageNoSubmit();
    const result = await runLeverFlow(page, {
      jobId: "job-3",
      applyUrl: "https://jobs.lever.co/klarna/xyz789/apply",
      persona: { fullName: "Jane Doe", email: "jane@test.com" },
      jobTitle: "Dev",
      jobCompany: "Klarna",
      resumePath: "/resume.pdf",
    });

    expect(result.status).toBe("manual");
    expect(result.error).toContain("Submit button not found");
  });
});
