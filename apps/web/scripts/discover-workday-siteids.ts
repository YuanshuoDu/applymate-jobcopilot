/**
 * discover-workday-siteids.ts
 *
 * Playwright script that navigates to Workday tenant career portals and
 * intercepts XHR requests to /wday/cxs/ to extract the correct siteId.
 *
 * Usage: pnpm --filter web exec tsx scripts/discover-workday-siteids.ts
 *
 * KNOWN LIMITATION (2026-05-22):
 * All 33 entries in workday.yaml use the wd3 subdomain (e.g. sap.wd3.myworkdayjobs.com).
 * Testing shows every wd3 tenant redirects to community.workday.com maintenance/invalid
 * pages -- the correct wd{N} subdomain varies per employer and must be discovered
 * manually from each company's public career page redirect. Until the baseUrl is
 * corrected, CXS interception cannot succeed.
 *
 * The script remains as a framework: once correct tenant URLs are provided,
 * it performs search interaction and intercepts siteId from CXS requests.
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
  const unreachable = new Set<string>();

  for (const employer of targets) {
    const tenantUrl = employer.baseUrl + "/" + employer.tenant;
    console.log("[" + employer.name + "] " + tenantUrl + " ...");

    const page = await browser.newPage();
    let discovered: string | null = null;
    let isUnreachable = false;

    page.on("request", req => {
      const url = req.url();
      const match = url.match(/\/wday\/cxs\/[^/]+\/([^/]+)\//);
      if (match && match[1] !== employer.siteId) {
        discovered = match[1];
      }
    });

    try {
      await page.goto(tenantUrl, { timeout: 30_000, waitUntil: "domcontentloaded" });
      await page.waitForTimeout(5000);

      // Detect maintenance/unreachable pages
      const finalUrl = page.url();
      if (finalUrl.includes("community.workday.com") || finalUrl.includes("maintenance-page")) {
        isUnreachable = true;
        unreachable.add(employer.tenant);
      }

      // Try search interaction to trigger CXS
      if (!isUnreachable) {
        const input = page.locator('input[type="text"]').first();
        if (await input.isVisible({ timeout: 2000 }).catch(() => false)) {
          await input.fill("engineer");
          await input.press("Enter");
          await page.waitForTimeout(4000);
        }
      }
    } catch (err: any) {
      console.log("  (!!) Error: " + err.message);
      isUnreachable = true;
    }

    if (isUnreachable) {
      console.log("  (!!) Unreachable (wd subdomain may be wrong)");
    } else if (discovered) {
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
  console.log("Unreachable: " + unreachable.size);
  if (discoveries.size > 0) {
    console.log("\nUpdating workday.yaml ...");
    updateWorkdayYaml(discoveries);
    console.log("Done.\n");
    for (const [tenant, siteId] of discoveries) {
      console.log("  " + tenant + ": " + siteId);
    }
  } else if (unreachable.size > 0) {
    console.log("\nAll tested tenants appear to use incorrect wd{N} subdomains.");
    console.log("Workday.yaml baseUrl values need manual correction before this script can discover siteIds.");
    console.log("Visit each company public career page -> click Jobs -> note the redirect URL to get correct baseUrl.");
  } else {
    console.log("\nNo discoveries or errors. Nothing changed.");
  }
}
main().catch(err => { console.error("Fatal:", err); process.exit(1); });
