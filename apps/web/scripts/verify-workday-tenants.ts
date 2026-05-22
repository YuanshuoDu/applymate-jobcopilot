/**
 * Workday tenant verification script.
 *
 * Hits the CXS search endpoint for every employer in workday.yaml
 * and reports the HTTP status + total jobs. Outputs a summary table
 * and a list of employers that need status updates.
 *
 * Usage:
 *   npx tsx apps/web/scripts/verify-workday-tenants.ts
 *
 * Output columns: Name, Country, HTTP status, Total jobs, Current status ? New status
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { load } from "js-yaml";
import { fileURLToPath } from "url";

// ?? Types ??????????????????????????????????????????????????????????????????

interface WorkdayEmployer {
  name:     string;
  tenant:   string;
  siteId:   string;
  baseUrl:  string;
  country:  string;
  tier:     1 | 2 | 3;
  status:   "verified" | "pending" | "unreachable";
}

interface VerifyResult extends WorkdayEmployer {
  httpStatus:   number;
  totalJobs:    number | null;
  newStatus:    "verified" | "pending" | "unreachable";
  errorMessage: string | null;
}

interface CxsSearchResult {
  total: number;
  jobPostings: unknown[];
}

// ?? Resolve paths ?????????????????????????????????????????????????????????

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const YAML_PATH  = resolve(__dirname, "..", "src", "lib", "agent", "registries", "workday.yaml");

const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

// ?? Verify one employer ???????????????????????????????????????????????????

async function verifyOne(emp: WorkdayEmployer): Promise<VerifyResult> {
  const url = `${emp.baseUrl}/wday/cxs/${emp.tenant}/${emp.siteId}/jobs`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent":   USER_AGENT,
      },
      body: JSON.stringify({
        appliedFacets: {},
        limit: 1,
        offset: 0,
        searchText: "",
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    // ?? Determine new status ??????????????????????????????
    let newStatus: VerifyResult["newStatus"] = "pending";
    let totalJobs: number | null = null;
    let errorMessage: string | null = null;

    if (resp.ok) {
      const json = (await resp.json()) as CxsSearchResult;
      totalJobs = json.total ?? 0;
      // Consider "verified" if endpoint returns 200 and total > 0
      // Keep as "pending" if total is 0 (could be empty site)
      newStatus = totalJobs > 0 ? "verified" : "pending";
    } else if (resp.status === 401 || resp.status === 403) {
      newStatus = "unreachable";
      errorMessage = `Auth error (${resp.status})`;
    } else if (resp.status === 404) {
      newStatus = "unreachable";
      errorMessage = "Tenant or siteId not found (404)";
    } else if (resp.status === 422) {
      newStatus = "unreachable";
      errorMessage = "Bad request ? likely wrong tenant/siteId (422)";
    } else {
      newStatus = "pending";
      errorMessage = `Unexpected status ${resp.status}`;
    }

    return {
      ...emp,
      httpStatus: resp.status,
      totalJobs,
      newStatus,
      errorMessage,
    };
  } catch (err) {
    return {
      ...emp,
      httpStatus: 0,
      totalJobs: null,
      newStatus: "pending",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

// ?? Main ??????????????????????????????????????????????????????????????????

async function main() {
  // Load YAML
  const raw = readFileSync(YAML_PATH, "utf-8");
  const doc = load(raw) as { employers: WorkdayEmployer[] };

  if (!doc?.employers || !Array.isArray(doc.employers)) {
    console.error(`ERROR: ${YAML_PATH} is missing or malformed`);
    process.exit(1);
  }

  const total = doc.employers.length;
  console.log(`\nWorkday Tenant Verification`);
  console.log(`========================================`);
  console.log(`File:     ${YAML_PATH}`);
  console.log(`Entries:  ${total}`);
  console.log(`\nVerifying...\n`);

  // Verify all employers sequentially (respect rate limits)
  const results: VerifyResult[] = [];
  for (let i = 0; i < doc.employers.length; i++) {
    const emp = doc.employers[i];
    process.stdout.write(`  [${String(i + 1).padStart(2, "0")}/${total}] ${emp.name.padEnd(22)} `);

    const result = await verifyOne(emp);

    const mark = result.newStatus === "verified"
      ? "?"
      : result.newStatus === "unreachable"
        ? "?"
        : "?";

    process.stdout.write(`${mark}  HTTP ${result.httpStatus}`);

    if (result.totalJobs != null) {
      process.stdout.write(`  jobs=${result.totalJobs}`);
    }
    if (result.errorMessage) {
      process.stdout.write(`  (${result.errorMessage})`);
    }
    process.stdout.write("\n");

    results.push(result);

    // Small delay between requests to be polite
    if (i < doc.employers.length - 1) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // ?? Summary table ????????????????????????????????????????????????????????
  console.log(`\n`);
  console.log(`SUMMARY`);
  console.log(`${"?".repeat(100)}`);
  console.log(
    `${"Name".padEnd(22)} ${"Country".padEnd(3)} ${"HTTP".padStart(5)} ${"Jobs".padStart(8)} ${"New status".padEnd(14)} ${"Current".padEnd(14)}`
  );
  console.log(`${"?".repeat(100)}`);

  for (const r of results) {
    const jobStr = r.totalJobs != null ? String(r.totalJobs).padStart(8) : "       --";
    const changed = r.newStatus !== r.status ? " ? changed" : "";
    console.log(
      `${r.name.padEnd(22)} ${r.country.padEnd(3)} ${String(r.httpStatus).padStart(4)} ${jobStr} ${r.newStatus.padEnd(14)} ${r.status.padEnd(14)}${changed}`
    );
  }
  console.log(`${"?".repeat(100)}`);

  // ?? Stats ?????????????????????????????????????????????????????????????????
  const verified    = results.filter(r => r.newStatus === "verified");
  const unreachable = results.filter(r => r.newStatus === "unreachable");
  const pending     = results.filter(r => r.newStatus === "pending");

  console.log(`\nDone. ${verified.length} verified, ${unreachable.length} unreachable, ${pending.length} pending.`);

  // ?? Changed entries ???????????????????????????????????????????????????????
  const changed = results.filter(r => r.newStatus !== r.status);
  if (changed.length > 0) {
    console.log(`\nSTATUS CHANGES (${changed.length}):`);
    for (const r of changed) {
      console.log(`  ${r.name}: ${r.status} ? ${r.newStatus}`);
    }
  } else {
    console.log(`\nNo status changes needed.`);
  }

  // ?? YAML snippet for manual update ????????????????????????????????????????
  if (changed.length > 0) {
    console.log(`\nYAML patch to apply in workday.yaml:`);
    console.log(`  # Update the "status" field for each employer listed below:`);
    for (const r of changed) {
      console.log(`  #   - { name: "${r.name}", status: "${r.status}" ? "${r.newStatus}" }`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
