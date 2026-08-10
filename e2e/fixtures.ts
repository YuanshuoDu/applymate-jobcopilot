import { expect, test as base, type Page, type Route } from "@playwright/test";

export const demoUser = {
  email: "demo@applymate.ai",
  password: "demo1234",
};

type Job = {
  id: string;
  company: string;
  logo: string;
  role: string;
  location: string;
  status: "saved" | "applied" | "interview" | "offer" | "rejected";
  workflowState: "draft" | "ready_to_apply" | "submitted";
  score: number | null;
  url: string;
  description: string;
  salary: string;
  source: string;
  notes?: string | null;
  coverLetter?: string | null;
  keywords?: string | null;
  analysisNote?: string | null;
  followUpAt?: string | null;
  appliedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

type E2eFixtures = {
  app: {
    jobs: Job[];
    installMocks: () => Promise<void>;
    login: () => Promise<void>;
    goTo: (label: string | RegExp) => Promise<void>;
  };
};

const now = "2026-06-06T12:00:00.000Z";
const generatedCoverLetter =
  "Dear Hiring Team, I am excited to apply my backend systems experience to this role and help your team ship reliable job-search products.";

function makeSeedJobs(): Job[] {
  return [
    {
      id: "e2e-job-1",
      company: "Cloudflare",
      logo: "CF",
      role: "Systems Engineer",
      location: "Remote",
      status: "saved",
      workflowState: "draft",
      score: null,
      url: "https://boards.greenhouse.io/cloudflare/jobs/123456",
      description: "Build distributed systems with TypeScript, Go, PostgreSQL, and observability.",
      salary: "EUR 80k-100k",
      source: "agent",
      coverLetter: null,
      keywords: null,
      analysisNote: null,
      followUpAt: null,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

async function json(route: Route, data: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(data),
  });
}

function statsFromJobs(jobs: Job[]) {
  return {
    total: jobs.length,
    saved: jobs.filter(job => job.status === "saved").length,
    applied: jobs.filter(job => job.status === "applied").length,
    inProgress: jobs.filter(job => job.status === "applied" || job.status === "interview").length,
    interviews: jobs.filter(job => job.status === "interview").length,
    offers: jobs.filter(job => job.status === "offer").length,
    thisWeek: 0,
  };
}

function pipelineFromJobs(jobs: Job[]) {
  return jobs.reduce<Record<string, number>>((acc, job) => {
    acc[job.status] = (acc[job.status] ?? 0) + 1;
    return acc;
  }, {});
}

function statusCountsFromJobs(jobs: Job[]) {
  return {
    saved: jobs.filter(job => job.status === "saved").length,
    applied: jobs.filter(job => job.status === "applied").length,
    interview: jobs.filter(job => job.status === "interview").length,
    offer: jobs.filter(job => job.status === "offer").length,
    rejected: jobs.filter(job => job.status === "rejected").length,
  };
}

function agentConfig() {
  return {
    id: "agent-config-e2e",
    isRunning: true,
    dailyLimit: 10,
    minMatchScore: 75,
    autoApply: false,
    requireApproval: true,
    targetLocations: ["Remote"],
    targetRoles: ["Backend Engineer", "Systems Engineer"],
    excludeCompanies: [],
    priorityCompanies: [],
    autoCoverLetter: false,
    coverTone: "professional",
    useTailoredCV: false,
    salaryMin: 0,
    salaryMax: 0,
    notifyApply: true,
    notifyReject: true,
    weeklySummary: false,
    followUpReminder: true,
    followUpDays: 7,
    model: "claude-sonnet-4-6",
  };
}

async function installAppMocks(page: Page, jobs: Job[]) {
  let generatedCoverLetter: Job["coverLetter"] = null;
  await page.route("**/api/me", route =>
    json(route, {
      id: "e2e-user",
      email: demoUser.email,
      name: "E2E Demo",
      plan: "pro",
      onboardedAt: now,
    }),
  );

  await page.route("**/api/notifications**", route =>
    json(route, { notifications: [], unreadCount: 0 }),
  );
  await page.route("**/api/notifications/mark-read", route => json(route, { ok: true }));
  await page.route("**/api/gmail/unread", route => json(route, { hasGmail: false, unread: 0 }));

  await page.route("**/api/dashboard", route =>
    json(route, {
      stats: statsFromJobs(jobs),
      pipeline: pipelineFromJobs(jobs),
      followUpsDue: [],
      savedJobs: jobs.filter(job => job.status === "saved").map(job => ({
        id: job.id,
        company: job.company,
        role: job.role,
        score: job.score,
        status: job.status,
        url: job.url,
        createdAt: job.createdAt,
      })),
      recentJobs: jobs,
      activity: [],
      pendingRecommendationCount: 0,
      agentConfig: agentConfig(),
      hasResume: true,
    }),
  );

  await page.route("**/api/jobs?**", route => {
    const url = new URL(route.request().url());
    const query = url.searchParams.get("q")?.toLowerCase() ?? "";
    const filtered = query
      ? jobs.filter(job =>
          `${job.company} ${job.role} ${job.location}`.toLowerCase().includes(query),
        )
      : jobs;
    return json(route, {
      jobs: filtered,
      total: filtered.length,
      page: Number(url.searchParams.get("page") ?? 1),
      pageSize: Number(url.searchParams.get("pageSize") ?? 50),
      statusCounts: statusCountsFromJobs(jobs),
    });
  });

  await page.route("**/api/jobs", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = await route.request().postDataJSON();
    const job: Job = {
      id: "e2e-job-saved",
      company: body.company,
      logo: body.logo ?? String(body.company).slice(0, 2).toUpperCase(),
      role: body.role,
      location: body.location ?? "",
      status: body.status ?? "saved",
      workflowState: body.status && body.status !== "saved" ? "submitted" : "draft",
      score: null,
      url: body.url ?? "",
      description: body.description ?? "",
      salary: body.salary ?? "",
      source: body.source ?? "manual",
      coverLetter: null,
      keywords: null,
      analysisNote: null,
      followUpAt: null,
      createdAt: now,
      updatedAt: now,
    };
    jobs.unshift(job);
    return json(route, job, 201);
  });

  await page.route("**/api/activity**", route => json(route, []));
  await page.route("**/api/resume", route =>
    json(route, [{ id: "resume-1", name: "Main Resume", kind: "base", isDefault: true, createdAt: now, updatedAt: now }]),
  );
  await page.route("**/api/resume/default", route =>
    json(route, {
      id: "resume-1",
      name: "Main Resume",
      content: {
        contact: { name: "E2E Demo", email: demoUser.email },
        summary: "Backend engineer focused on distributed systems.",
        skills: ["TypeScript", "Go", "PostgreSQL", "Playwright"],
        experience: [],
        education: [],
      },
    }),
  );
  await page.route("**/api/resume/resume-1", route =>
    json(route, {
      id: "resume-1",
      name: "Main Resume",
      content: {
        contact: { name: "E2E Demo", email: demoUser.email },
        summary: "Backend engineer focused on distributed systems.",
        skills: ["TypeScript", "Go", "PostgreSQL", "Playwright"],
        experience: [],
        education: [],
      },
    }),
  );
  await page.route("**/api/resume/resume-tailored-1", route =>
    json(route, {
      id: "resume-tailored-1",
      name: "Systems Engineer · Cloudflare",
      kind: "adapted",
      targetJobId: "e2e-job-1",
      isDefault: false,
      content: {
        contact: { name: "E2E Demo", email: demoUser.email },
        summary: "Backend engineer focused on distributed systems.",
        skills: ["TypeScript", "Go", "PostgreSQL", "Playwright"],
        experience: [],
        education: [],
      },
    }),
  );

  await page.route("**/api/search/unified**", route =>
    json(route, {
      jobs: [
        {
          id: "search-result-1",
          title: "Backend Engineer",
          company: "Acme Systems",
          location: "Dublin, IE",
          salary: "EUR 75k-95k",
          description: "Build APIs, queues, and data services for job-search automation.",
          url: "https://example.com/acme-backend",
          postedAt: now,
          jobType: "Full-time",
          logo: "AC",
          source: "linkedin",
          keySkills: ["TypeScript", "PostgreSQL", "Queues"],
          score: 94,
        },
      ],
      meta: {
        sourcesUsed: ["linkedin"],
        sourceBreakdown: { linkedin: 1 },
        routing: "E2E mocked search",
        totalRaw: 1,
        totalDeduped: 1,
        totalFiltered: 1,
        durationMs: 12,
        topSkills: ["typescript", "postgresql"],
        apiKeys: { rapidapi: true, adzuna: false, reed: false, careerjet: false },
      },
    }),
  );

  await page.route("**/api/ai/score", route =>
    json(route, {
      score: 91,
      keywords: "TypeScript, PostgreSQL, distributed systems",
      matchedKeywords: ["TypeScript", "PostgreSQL"],
      missingKeywords: ["Kubernetes"],
      sectionMatches: [],
      missingItems: [],
      sectionScores: {},
      sectionTips: {},
      skillsGap: [],
      strengthSummary: "Strong backend systems match.",
    }),
  );

  await page.route("**/api/ai/cover-letter", route =>
    json(route, { coverLetter: generatedCoverLetter }),
  );

  await page.route("**/api/jobs/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();

    if (pathname.endsWith("/cover-letters") && method === "GET") {
      return json(route, generatedCoverLetter ? [{
        id: "e2e-cover-letter-1",
        userId: "e2e-user",
        jobId: "e2e-job-1",
        resumeId: "resume-tailored-1",
        content: generatedCoverLetter,
        tone: "professional",
        templateId: "clean",
        templateOptions: {},
        origin: "ai",
        isFinal: true,
        createdAt: now,
        updatedAt: now,
      }] : []);
    }

    if (method === "POST" && pathname.endsWith("/tailor-resume")) {
      return json(route, { adaptedResumeId: "resume-tailored-1" });
    }

    if (method === "POST" && pathname.endsWith("/cover-letters/generate")) {
      generatedCoverLetter = generatedCoverLetter ?? generatedCoverLetterText;
      jobs[0].coverLetter = generatedCoverLetter;
      return json(route, {
        id: "e2e-cover-letter-1",
        userId: "e2e-user",
        jobId: "e2e-job-1",
        resumeId: "resume-tailored-1",
        content: generatedCoverLetter,
        tone: "professional",
        templateId: "clean",
        templateOptions: {},
        origin: "ai",
        isFinal: true,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (method === "POST" && pathname.endsWith("/audit-application")) {
      return json(route, {
        verdict: "pass",
        summary: "All application claims are supported.",
        matchScore: 91,
        findings: [],
        source: "current_resume",
        auditedAt: now,
      });
    }

    if (method === "GET" && pathname.endsWith("/audit-application")) {
      return json(route, null);
    }

    if (method === "PATCH" && pathname.endsWith("/assign")) {
      const body = await request.postDataJSON();
      const job = jobs.find(item => item.id === pathname.split("/").at(-2));
      if (!job) return json(route, { error: "Not found" }, 404);
      Object.assign(job, body, { updatedAt: now });
      return json(route, job);
    }

    if (method === "POST" && pathname.endsWith("/score-all")) {
      for (const job of jobs) {
        job.score = 91;
        job.keywords = "TypeScript, PostgreSQL, distributed systems";
      }
      return json(route, { scored: jobs.length, failed: 0, remaining: 0 });
    }

    if (method === "PATCH") {
      const id = pathname.split("/").at(-1);
      const body = await request.postDataJSON();
      const index = jobs.findIndex(job => job.id === id);
      if (index === -1) return json(route, { error: "Not found" }, 404);
      jobs[index] = { ...jobs[index], ...body, updatedAt: now };
      return json(route, jobs[index]);
    }

    return route.fallback();
  });

  await page.route("**/api/agent", async route => {
    if (route.request().method() === "PATCH") return json(route, agentConfig());
    return json(route, agentConfig());
  });
  await page.route("**/api/agent/scout", route => json(route, { queued: true }));
  await page.route("**/api/agent/roles", route =>
    json(route, [
      { role: "scout", enabled: true, provider: "anthropic", model: "claude-sonnet-4-6" },
      { role: "analyst", enabled: true, provider: "anthropic", model: "claude-sonnet-4-6" },
    ]),
  );
  await page.route("**/api/agent/roles/custom", route => json(route, []));
  await page.route("**/api/agent/run**", route =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        'event: start\ndata: {"total":1}\n',
        'event: role_start\ndata: {"role":"scout","label":"Scout","model":"mocked-ai","icon":"search"}\n',
        'event: role_done\ndata: {"role":"scout","icon":"search","summary":"Scout found 1 result","count":1,"durationMs":20}\n',
        'event: job_done\ndata: {"jobId":"e2e-job-1","company":"Cloudflare","role":"Systems Engineer","score":91,"autoApplied":false,"matchedKeywords":["TypeScript"]}\n',
        'event: done\ndata: {"processed":1,"applied":0,"pending":1,"skipped":0,"failed":0,"durationMs":50}\n',
        "",
      ].join("\n"),
    }),
  );
  await page.route("**/api/agent/chat", route =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        'event: session\ndata: {"sessionId":"e2e-session-1"}\n',
        'event: text\ndata: {"delta":"Starting the matching job run."}\n',
        'event: action\ndata: {"type":"start_run"}\n',
        "",
      ].join("\n"),
    }),
  );
  await page.route("**/api/agent/sessions/*/events", route => json(route, { events: [] }));
}

const generatedCoverLetterText =
  "Dear Hiring Team, I am excited to apply my backend systems experience to this role and help your team ship reliable job-search products.";

export const test = base.extend<E2eFixtures>({
  app: async ({ page }, use) => {
    const jobs = makeSeedJobs();
    const installMocks = () => installAppMocks(page, jobs);
    const login = async () => {
      await page.goto("/login");
      await page.getByPlaceholder("you@example.com").fill(demoUser.email);
      await page.locator('input[type="password"]').fill(demoUser.password);
      await page.getByRole("button", { name: /^(Sign in|登录)$/ }).click();
      await page.waitForURL(url => url.pathname === "/", { timeout: 15_000 });
      await expect(page.getByText("ApplyMate AI").first()).toBeVisible();
      await expect(page.getByRole("button", { name: /Dashboard|仪表盘/ })).toBeVisible({ timeout: 15_000 });
    };
    const goTo = async (label: string | RegExp) => {
      await page.getByRole("button", { name: label }).click();
    };
    await use({ jobs, installMocks, login, goTo });
  },
});

export { expect };
