import type { Page } from "playwright-core";

const CAPTCHA_IFRAME_SELECTORS = [
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="google.com/recaptcha"]',
  'iframe[src*="hcaptcha.com"]',
];

const CAPTCHA_WIDGET_SELECTORS = [".g-recaptcha", ".h-captcha", "[data-sitekey]"];

const CAPTCHA_TEXT_PATTERNS = [/verify you are human/i, /captcha/i];

const CAPSOLVER_CREATE_TASK_URL = "https://api.capsolver.com/createTask";
const CAPSOLVER_GET_TASK_URL = "https://api.capsolver.com/getTaskResult";

type CapSolverCreateResponse = {
  errorId?: number;
  errorCode?: string;
  errorDescription?: string;
  taskId?: string;
};

type CapSolverResultResponse = {
  errorId?: number;
  errorCode?: string;
  errorDescription?: string;
  status?: "idle" | "processing" | "ready" | "failed";
  solution?: {
    gRecaptchaResponse?: string;
    token?: string;
  };
};

export type SolveCaptchaOptions = {
  pollIntervalMs?: number;
  maxAttempts?: number;
};

export async function detectCaptcha(page: Page): Promise<boolean> {
  for (const selector of [...CAPTCHA_IFRAME_SELECTORS, ...CAPTCHA_WIDGET_SELECTORS]) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count > 0) return true;
  }

  const bodyText = await page.textContent("body").catch(() => null);
  return CAPTCHA_TEXT_PATTERNS.some((pattern) => pattern.test(bodyText ?? ""));
}

export async function solveCaptcha(
  page: Page,
  options: SolveCaptchaOptions = {}
): Promise<boolean> {
  const clientKey = process.env.CAPSOLVER_API_KEY;
  if (!clientKey) return false;

  const websiteKey = await extractSiteKey(page);
  if (!websiteKey) return false;

  const websiteURL = page.url();
  const createResponse = await postCapSolver<CapSolverCreateResponse>(
    CAPSOLVER_CREATE_TASK_URL,
    {
      clientKey,
      task: {
        type: "ReCaptchaV2TaskProxyLess",
        websiteURL,
        websiteKey,
      },
    }
  ).catch(() => null);

  if (!createResponse || createResponse.errorId || !createResponse.taskId) {
    return false;
  }

  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const maxAttempts = options.maxAttempts ?? 30;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await delay(pollIntervalMs);
    }

    const result = await postCapSolver<CapSolverResultResponse>(CAPSOLVER_GET_TASK_URL, {
      clientKey,
      taskId: createResponse.taskId,
    }).catch(() => null);

    if (!result || result.errorId) return false;
    if (result.status !== "ready") continue;

    const token = result.solution?.gRecaptchaResponse ?? result.solution?.token;
    if (!token) return false;

    await injectCaptchaToken(page, token);
    return true;
  }

  return false;
}

async function extractSiteKey(page: Page): Promise<string | null> {
  const siteKey = await page
    .locator("[data-sitekey]")
    .first()
    .getAttribute("data-sitekey")
    .catch(() => null);

  return siteKey?.trim() || null;
}

async function postCapSolver<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`CapSolver request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

async function injectCaptchaToken(page: Page, token: string): Promise<void> {
  await page.evaluate((solutionToken) => {
    const triggerCallback = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return false;

      for (const entry of Object.values(value as Record<string, unknown>)) {
        if (typeof entry === "function") {
          try {
            entry(solutionToken);
            return true;
          } catch {
            return false;
          }
        }

        if (triggerCallback(entry)) return true;
      }

      return false;
    };

    const responseEl = document.getElementById("g-recaptcha-response") as
      | HTMLTextAreaElement
      | HTMLInputElement
      | null;

    if (responseEl) {
      responseEl.value = solutionToken;
      responseEl.dispatchEvent(new Event("input", { bubbles: true }));
      responseEl.dispatchEvent(new Event("change", { bubbles: true }));
    }

    const recaptchaClients = (
      window as typeof window & {
        ___grecaptcha_cfg?: {
          clients?: Record<string, unknown>;
        };
      }
    ).___grecaptcha_cfg?.clients;

    for (const client of Object.values(recaptchaClients ?? {})) {
      triggerCallback(client);
    }
  }, token);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
