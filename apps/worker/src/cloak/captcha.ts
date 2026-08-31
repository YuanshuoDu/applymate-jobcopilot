import type { Page } from "playwright-core";

const CAPTCHA_SELECTORS = [
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="google.com/recaptcha"]',
  'iframe[src*="hcaptcha.com"]',
  ".g-recaptcha",
  ".h-captcha",
  "[data-sitekey]",
];

const CAPTCHA_TEXT_PATTERNS = [/verify you are human/i, /captcha/i];

/** Detection only. CAPTCHA solving and token injection are intentionally unsupported. */
export async function detectCaptcha(page: Page): Promise<boolean> {
  for (const selector of CAPTCHA_SELECTORS) {
    if (await page.locator(selector).count()) return true;
  }
  const bodyText = await page.textContent("body");
  return CAPTCHA_TEXT_PATTERNS.some(pattern => pattern.test(bodyText ?? ""));
}
