/**
 * Minimal CLI for running a single discovery source against one employer slug.
 *
 * Usage:
 *   pnpm --filter web exec tsx scripts/scout-one.ts greenhouse booking
 *   pnpm --filter web exec tsx scripts/scout-one.ts lever spotify
 *
 * Prints discovered jobs to stdout. No DB writes.
 */

import { fetchGreenhouse } from "../src/lib/agent/sources/greenhouse"
import { fetchLever } from "../src/lib/agent/sources/lever"

async function main() {
  const args = process.argv.slice(2)
  if (args.length < 2) {
    console.error("Usage: pnpm --filter web exec tsx scripts/scout-one.ts <ats> <slug>")
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

main().catch((err) => {
  console.error(err)
  process.exit(1)
})