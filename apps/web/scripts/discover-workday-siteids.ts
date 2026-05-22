/**
 * discover-workday-siteids.ts
 *
 * Playwright script that navigates to company career pages and intercepts
 * XHR requests to /wday/cxs/ to extract the correct Workday siteId.
 *
 * Usage: pnpm --filter web exec tsx apps/web/scripts/discover-workday-siteids.ts
 */

import { chromium } from "playwright-core";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

// ©¤©¤ Career page URLs ©¤©¤
// Maps tenant (from workday.yaml) ¡ú public career page that loads Workday
const CAREER_URLS: Record<string, string> = {
  sap:      "https://www.sap.com/careers.html",
  adidas:   "https://careers.adidas-group.com/",
  siemens:  "https://jobs.siemens.com/",
  bmw:      "https://www.bmwgroup.jobs/",
  allianz:  "https://careers.allianz.com/",
  philips:  "https://www.philips.com/a-w/careers.html",
  asml:     "https://www.asml.com/en/careers",
  ericsson: "https://jobs.ericsson.com/",
  nokia:    "https://www.nokia.com/careers/",
  novartis: "https://www.novartis.com/careers",
  // Additional targets
  mercedes: "https://jobs.mercedes-benz.com/",
  vw:       "https://www.volkswagen-groupservices.com/jobs",
  basf:     "https://www.basf.com/global/en/careers.html",
  bayer:    "https://www.bayer.com/en/careers",
  telekom:  "https://www.telekom.com/en/careers",
};

// ©¤©¤ YAML I/O ©¤©¤
const YAML_PATH = resolve(__dirname, "../src/lib/agent/registries/workday.yaml");

interface WorkdayEmployer {
  name: string;
  tenant: string;
  siteId: string;
  baseUrl: string;
  country: string;
  tier: 1 | 2 | 3;
  status: "verified" | "pending" | "unreachable";
}

function readWorkdayYaml(): WorkdayEmployer[] {
  const raw = readFileSync(YAML_PATH, "utf-8");
  // Simple regex extraction ¡ª avoids YAML dependency
  const entries: WorkdayEmployer[] = [];
  const lines = raw.split("\n");
  let current: Record<string, string> = {};

  for (const line of lines) {
    const match = line.match(/^\s*-\s*\{\s*name:\s*"([^"]+)",\s*tenant:\s*"([^"]+)",\s*siteId:\s*"([^"]+)",\s*baseUrl:\s*"([^"]+)",\s*country:\s*"([^"]+)",\s*tier:\s*(\d),\s*status:\s*"([^"]+)"\s*\}/);
    if (match) {
      entries.push({
        name: match[1],
        tenant: match[2],
        siteId: match[3],
        baseUrl: match[4],
        country: match[5],
        tier: Number(match[6]) as 1 | 2 | 3,
        status: match[7] as WorkdayEmployer["status"],
      });
    }
  }
  return entries;
}

function updateWorkdayYaml(discoveries: Map<string, string>): void {
  let raw = readFileSync(YAML_PATH, "utf-8");

  for (const [tenant, siteId] of discoveries) {
    // Pattern: tenant: "tenantName", siteId: "oldValue",
    const pattern = new RegExp(
      (tenant:\\s*""\\s*,\\s*siteId:\\s*)"[^"]*",
      "g"
    );
    raw = raw.replace(pattern, $"");

    // Update status from pending ¡ú verified
    const statusPattern = new RegExp(
      (tenant:\\s*""[^}]*status:\\s*)"pending",
      "g"
    );
    raw = raw.replace(statusPattern, $"verified");
  }

  writeFileSync(YAML_PATH, raw, "utf-8");
}

// ©¤©¤ Main ©¤©¤
async function main() {
  console.log("=== Workday siteId Discovery ===\n");

  const employers = readWorkdayYaml();
  console.log(Loaded  employers from workday.yaml\n);

  // Filter: only pending entries that have a known career URL
  const targets = employers.filter(
    (e) => e.status === "pending" && CAREER_URLS[e.tenant]
  );

  console.log(Targets with career URLs: \n);
  if (targets.length === 0) {
    console.log("No pending targets with known career URLs. Exiting.");
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const discoveries = new Map<string, string>();

  for (const employer of targets) {
    const careerUrl = CAREER_URLS[employer.tenant];
    console.log([] Opening  ...);

    const page = await browser.newPage();
    let discovered: string | null = null;

    // Intercept XHR/fetch requests to Workday CXS API
    page.on("request", (req) => {
      const url = req.url();
      const match = url.match(/\/wday\/cxs\/[^/]+\/([^/]+)\/jobs/);
      if (match && match[1] !== employer.siteId) {
        discovered = match[1];
      }
    });

    try {
      await page.goto(careerUrl, { timeout: 30_000, waitUntil: "domcontentloaded" });
      // Wait for Workday widget to load and fire XHR requests
      await page.waitForTimeout(8000);
    } catch (err) {
      console.log(  ? Navigation error: );
    }

    if (discovered) {
      console.log(  ? siteId found: "" (was ""));
      discoveries.set(employer.tenant, discovered);
    } else {
      console.log(  ? No Workday XHR intercepted (career page may not load Workday JS));
    }

    await page.close();
    // Rate-limit: 2s between pages
    await new Promise((r) => setTimeout(r, 2000));
  }

  await browser.close();

  // ©¤©¤ Report ©¤©¤
  console.log(\n=== Results ===);
  console.log(Discovered:  / );
  if (discoveries.size > 0) {
    console.log("\nUpdating workday.yaml ...");
    updateWorkdayYaml(discoveries);
    console.log("Done. Run git diff to review changes.\n");

    for (const [tenant, siteId] of discoveries) {
      console.log(  : );
    }
  } else {
    console.log("\nNo siteIds discovered. workday.yaml unchanged.");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});