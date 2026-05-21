/**
 * Minimal CLI for running discovery sources against employer slugs.
 *
 * Single slug mode:
 *   pnpm --filter web exec tsx scripts/scout-one.ts greenhouse booking
 *   pnpm --filter web exec tsx scripts/scout-one.ts lever spotify
 *
 * Registry mode (batch all employers in the registry):
 *   pnpm --filter web exec tsx scripts/scout-one.ts --registry greenhouse
 *   pnpm --filter web exec tsx scripts/scout-one.ts --registry lever
 *
 * Prints discovered jobs to stdout. No DB writes.
 */

import { fetchGreenhouse } from "../src/lib/agent/sources/greenhouse"
import { fetchWorkday } from "../src/lib/agent/sources/workday"
import { fetchLever } from "../src/lib/agent/sources/lever"
import { loadRegistry, loadWorkdayRegistry, type Employer, type WorkdayEmployer } from "../src/lib/agent/registries"

type Ats = "greenhouse" | "lever" | "workday"

async function main() {
  const args = process.argv.slice(2)

  // Registry mode: --registry <ats>
  if (args[0] === "--registry") {
    const ats = args[1] as Ats | undefined
    if (!ats || !["greenhouse", "lever", "workday"].includes(ats)) {
      console.error("Usage: pnpm --filter web exec tsx scripts/scout-one.ts --registry <greenhouse|lever|workday>")
      process.exit(1)
    }
    await runRegistry(ats)
    return
  }

  // Single slug mode: <ats> <slug>
  if (args.length < 2) {
    console.error("Usage: pnpm --filter web exec tsx scripts/scout-one.ts <ats> <slug>")
    console.error("       pnpm --filter web exec tsx scripts/scout-one.ts --registry <greenhouse|lever>")
    process.exit(1)
  }

  const [ats, slug] = args

  let jobs
  if (ats === "greenhouse") {
    console.log(`Scouting greenhouse / ${slug} ...`)
    jobs = await fetchGreenhouse([slug])
  } else if (ats === "lever") {
    console.log(`Scouting lever / ${slug} ...`)
    jobs = await fetchLever([slug])
    } else if (ats === "workday") {
    const employers = loadWorkdayRegistry()
    const employer = employers.find((e: WorkdayEmployer) => e.tenant === slug)
    if (!employer) {
      console.error(`Tenant "${slug}" not found in workday.yaml registry. Available: ${employers.map((e: WorkdayEmployer) => e.tenant).join(", ")}`)
      process.exit(1)
    }
    console.log(`Scouting workday / ${employer.name} (${employer.tenant}) ...`)
    jobs = await fetchWorkday([employer])
  } else {
    console.error(`Unknown ATS: ${ats}. Supported: greenhouse, lever`)
    process.exit(1)
  }

  if (jobs.length === 0) {
    console.log("No jobs found.")
    return
  }

  for (const j of jobs) {
    console.log(`\n--- ${j.title} ---`)
    console.log(`  Company:     ${j.company}`)
    console.log(`  Location:    ${j.location}`)
    console.log(`  URL:         ${j.url}`)
    console.log(`  Description: ${j.description.slice(0, 200)}...`)
    console.log(`  Source:      ${j.source}`)
  }

  console.log(`\n${jobs.length} job(s) from ${slug}`)
}

async function runRegistry(ats: Ats) {
  if (ats === "workday") {
    const wdEmployers = loadWorkdayRegistry()
    console.log(`Registry workday: ${wdEmployers.length} employers`)

    console.log(`Fetching ${wdEmployers.length} employers (workday)...\n`)
    const jobs = await fetchWorkday(wdEmployers)

    const byEmployer = new Map<string, number>()
    for (const j of jobs) {
      const prev = byEmployer.get(j.company) ?? 0
      byEmployer.set(j.company, prev + 1)
    }

    for (const e of wdEmployers) {
      const count = byEmployer.get(e.name) ?? 0
      console.log(`  ${count.toString().padStart(4)} jobs  ${e.tenant} (${e.name}) [${e.status}]`)
    }

    const activeEmployers = [...byEmployer.keys()].length
    console.log(`\n${jobs.length} job(s) from ${activeEmployers} employer(s) [${wdEmployers.length} registered]`)
    return
  }

  const employers = loadRegistry(ats)
  console.log(`Registry ${ats}: ${employers.length} employers`)

  const slugs = employers.map((e: Employer) => e.slug)
  const fetcher = ats === "greenhouse" ? fetchGreenhouse : fetchLever

  console.log(`Fetching ${slugs.length} employers (${ats})...\n`)
  const jobs = await fetcher(slugs)

  // Count jobs per employer
  const byEmployer = new Map<string, number>()
  for (const j of jobs) {
    const prev = byEmployer.get(j.company) ?? 0
    byEmployer.set(j.company, prev + 1)
  }

  for (const e of employers) {
    const count = byEmployer.get(e.slug) ?? 0
    console.log(`  ${count.toString().padStart(4)} jobs  ${e.slug} (${e.name})`)
  }

  const activeEmployers = [...byEmployer.keys()].length
  console.log(`\n${jobs.length} job(s) from ${activeEmployers} employer(s) [${employers.length} registered]`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
