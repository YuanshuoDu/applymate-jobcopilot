/**
 * Enqueue a dry-run apply task for testing.
 * Usage:
 *   pnpm --filter worker exec tsx scripts/enqueue-dry-run.ts --url https://boards.greenhouse.io/booking/jobs/12345 --user-id test-user-1
 */
import { applyQueue } from "../src/queue/apply-queue.js";

function parseArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main() {
  const url = parseArg("--url");
  const userId = parseArg("--user-id") ?? "test-user-1";
  const jobId = parseArg("--job-id") ?? url?.split("/").pop() ?? "unknown";

  if (!url) {
    console.error("Usage: tsx scripts/enqueue-dry-run.ts --url <URL> [--user-id <ID>] [--job-id <ID>]");
    process.exit(1);
  }

  const job = await applyQueue.add("apply-task", {
    jobId,
    userId,
    applyUrl: url,
    personaId: "test-persona",
    resumePath: "test-resume.pdf",
    dryRun: true,
  });

  console.log(`Enqueued dry-run job: id=${job.id}, url=${url}, userId=${userId}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Enqueue failed:", err);
  process.exit(1);
});
