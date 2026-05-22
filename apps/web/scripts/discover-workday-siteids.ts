/**
 * discover-workday-siteids.ts
 *
 * Playwright script that navigates to Workday tenant pages and intercepts
 * XHR requests to /wday/cxs/ to extract the correct siteId.
 *
 * Usage: pnpm --filter web exec tsx scripts/discover-workday-siteids.ts
 */

import { chromium } from "playwright-core";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

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
  const entries: WorkdayEmployer[] = [];
  const re = /^\s*-\s*\{\s*name:\s*"([^"]+)",\s*tenant:\s*"([^"]+)",\s*siteId:\s*"([^"]+)",\s*baseUrl:\s*"([^"]+)",\s*country:\s*"([^"]+)",\s*tier:\s*(\d),\s*status:\s*"([^"]+)"\s*\}/;
  for (const line of raw.split("\n")) {
    const m = line.match(re);
    if (m) {
      entries.push({
        name: m[1], tenant: m[2], siteId: m[3], baseUrl: m[4],
        country: m[5], tier: Number(m[6]) as 1 | 2 | 3,
        status: m[7] as WorkdayEmployer["status"],
      });
    }
  }
  return entries;
}

function updateWorkdayYaml(discoveries: Map<string, string>): void {
  let raw = readFileSync(YAML_PATH, "utf-8");
  for (const [tenant, siteId] of discoveries) {
    const sitePat = new RegExp(
      '(tenant:\\s*"' + tenant + '"\\s*,\\s*siteId:\\s*)"[^"]*"',
      "g"
    );
    raw = raw.replace(sitePat, 'TMPL1' + siteId + 'TMPL2');
    raw = raw.replace(/TMPL1/g, '\x241"');
    raw = raw.replace(/TMPL2/g, '"');
    const statusPat = new RegExp(
      '(tenant:\\s*"' + tenant + '"[^}]*status:\\s*)"pending"',
      "g"
    );
    raw = raw.replace(statusPat, 'TMPL3');
    raw = raw.replace(/TMPL3/g, '\x241"verified"');
  }
  writeFileSync(YAML_PATH, raw, "utf-8");
}

async function main() {
  console.log("=== Workday siteId Discovery ===\n");
  const employers = readWorkdayYaml();
  console.log("Loaded " + employers.length + " employers from workday.yaml\n");

  // Target only pending entries
  const targets = employers.filter(e => e.status === "pending");
  console.log("Pending targets: " + targets.length + "\n");

  if (targets.length === 0) {
    console.log("No pending targets. Exiting.");
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const discoveries = new Map<string, string>();

  for (const employer of targets) {
    // Navigate to the Workday tenant landing page, which loads the job search widget
    const tenantUrl = employer.baseUrl + "/" + employer.tenant;
    console.log("[" + employer.name + "] " + tenantUrl + " ...");

    const page = await browser.newPage();
    let discovered: string | null = null;

    // Intercept XHR/fetch to Workday CXS API
    page.on("request", req => {
      const url = req.url();
      const match = url.match(/\/wday\/cxs\/[^/]+\/([^/]+)\//);
      if (match && match[1] !== employer.siteId) {
        discovered = match[1];
      }
    });

    try {
      await page.goto(tenantUrl, { timeout: 30_000, waitUntil: "domcontentloaded" });
      await page.waitForTimeout(8000);
    } catch (err: any) {
      console.log("  (!!) Navigation error: " + err.message);
    }

    if (discovered) {
      console.log('  (OK) siteId: "' + discovered + '" (was "' + employer.siteId + '")');
      discoveries.set(employer.tenant, discovered);
    } else {
      console.log("  (--) No CXS request intercepted");
    }

    await page.close();
    await new Promise(r => setTimeout(r, 2000));
  }

  await browser.close();

  console.log("\n=== Results ===");
  console.log("Discovered: " + discoveries.size + " / " + targets.length);
  if (discoveries.size > 0) {
    console.log("\nUpdating workday.yaml ...");
    updateWorkdayYaml(discoveries);
    console.log("Done.\n");
    for (const [tenant, siteId] of discoveries) {
      console.log("  " + tenant + ": " + siteId);
    }
  } else {
    console.log("\nNo siteIds discovered. workday.yaml unchanged.");
  }
}
main().catch(err => { console.error("Fatal:", err); process.exit(1); });
