import type { Pool } from "pg";
import {
  callLlm, loadWorkerAiConfig, OBJECTIVE_REVIEWED_FILL_BROWSER_START_SCHEMA,
  parseObjectiveReviewedFillSource, parseReviewedApplicationFillSource,
} from "@jobcopilot/shared";
import { generateResumePdf, type ResumeContent } from "./resume-pdf.js";
import { tailorResumeKeywords } from "./tailor-resume.js";
import type { ApplicationSubmitIdentity } from "../queue/application-submit-fence.js";

export interface TaskContext {
  persona: Record<string, string>;
  jobTitle: string;
  jobCompany: string;
  jobKeywords: string;
  applyUrl: string;
  coverLetterText: string | null;
  resumeTempPath?: string;
  confirmedAnswers: Record<string, string>;
}

export async function loadTaskContext(
  pool: Pool,
  userId: string,
  jobId: string,
  fallbackApplyUrl: string,
  applicationTaskId?: string,
  options: { objectiveOnly?: true } = {},
): Promise<TaskContext> {
  const objectiveOnly = options.objectiveOnly === true;
  const [userRes, jobRes, resumeRes] = await Promise.all([
    pool.query(
      'SELECT name, email, phone, location, linkedin, "personaFields", "accountStatus" FROM "User" WHERE id = $1',
      [userId]
    ),
    pool.query(
      objectiveOnly
        ? 'SELECT role, company, keywords, url FROM "Job" WHERE id = $1 AND "userId" = $2'
        : 'SELECT role, company, keywords, description, url, "coverLetter" FROM "Job" WHERE id = $1 AND "userId" = $2',
      [jobId, userId]
    ),
    objectiveOnly ? Promise.resolve(null) : pool.query(
      'SELECT content FROM "Resume" WHERE "userId" = $1 AND "isDefault" = true LIMIT 1',
      [userId]
    ),
  ]);

  if (!jobRes.rows[0]) {
    throw new Error(`Job ${jobId} not found for user ${userId}`);
  }

  const user = userRes.rows[0] ?? {};
  if (user.accountStatus !== "active") throw new Error("Account is not active");
  const job = jobRes.rows[0];

  // Build flat persona map from base fields
  const base: Record<string, string> = {
    fullName:   user.name     ?? "",
    email:      user.email    ?? "",
    phone:      user.phone    ?? "",
    location:   user.location ?? "",
    linkedinUrl: user.linkedin ?? "",
  };

  // Merge learned personaFields (stored as JSONB array)
  const learned: Record<string, string> = {};
  for (const f of (user.personaFields as Array<{ key: string; value: string }> ?? [])) {
    if (f.key && f.value) learned[f.key] = f.value;
  }
  const persona: Record<string, string> = { ...base, ...learned };
  const applyUrl = objectiveOnly
    ? (typeof job.url === "string" ? job.url.trim() : "")
    : job.url?.trim() || fallbackApplyUrl;
  if (objectiveOnly && !applyUrl) throw new Error("Objective application target is unavailable.");

  if (objectiveOnly) return {
    persona, jobTitle: job.role ?? "", jobCompany: job.company ?? "", jobKeywords: job.keywords ?? "",
    applyUrl, coverLetterText: null, confirmedAnswers: {},
  };

  // Export default resume to temp PDF file for file uploads
  let resumeTempPath: string | undefined;
  if (resumeRes?.rows[0]?.content) {
    const baseContent = resumeRes.rows[0].content as ResumeContent;
    // Tailor skills section with missing JD keywords (improves ATS pass rate)
    const tailored = job.keywords
      ? tailorResumeKeywords(baseContent, job.keywords)
      : baseContent;
    resumeTempPath = await generateResumePdf(userId, tailored);
  }

  const confirmedAnswers = applicationTaskId
    ? await loadConfirmedAnswers(pool, applicationTaskId, userId, jobId)
    : {};

  // Generate cover letter via LLM if not saved
  let coverLetterText: string | null = job.coverLetter ?? null;

  if (!coverLetterText && job.description && persona.email) {
    try {
      const aiConfig = await loadWorkerAiConfig(userId);
      const result = await callLlm(
        [
          {
            role: "user",
            content: [
              "Write a concise professional cover letter (150-200 words) for this job.",
              "CANDIDATE: " + (persona.fullName || ""),
              "JOB: " + (job.role ?? "") + " at " + (job.company ?? ""),
              "KEY REQUIREMENTS: " + (job.keywords ?? ""),
              "JD EXCERPT: " + (job.description ?? "").slice(0, 600),
              "Start with why excited about the role. No Dear/Subject. Body only.",
            ].join("\n"),
          },
        ],
        aiConfig,
        { userId, featureKey: "coverLetter", runtime: "worker" },
      ).catch(() => null);

      if (result?.text) {
        coverLetterText = result.text.trim();
        await pool
          .query(
            `UPDATE "Job" SET "coverLetter" = $1, "updatedAt" = NOW() WHERE id = $2`,
            [coverLetterText, jobId]
          )
          .catch(() => {});
      }
    } catch {
      // Cover letter generation unavailable — continue without it
    }
  }

  return {
    persona,
    jobTitle: job.role ?? "",
    jobCompany: job.company ?? "",
    jobKeywords: job.keywords ?? "",
    applyUrl,
    coverLetterText,
    resumeTempPath,
    confirmedAnswers,
  };
}

export type ApplyQueueMaterialMode = "ordinary" | "objective" | "blocked";

/** Reads only the exact persisted Fill selector and task-scoped Objective evidence before context loading. */
export async function readApplyQueueMaterialMode(pool: Pool, identity: ApplicationSubmitIdentity): Promise<ApplyQueueMaterialMode> {
  try {
    const turn = await pool.query<{ input: unknown }>(`SELECT turn."input" FROM agent_turns AS turn
      JOIN application_tasks AS task ON task."id"=$4 AND task."userId"=$3 AND task."jobId"=$5
        AND task."sessionId"=$2 AND task."fillTurnId"=turn."id"
        AND task."fillTurnSessionId"=turn."sessionId" AND task."fillTurnUserId"=turn."userId"
      WHERE turn."id"=$1 AND turn."sessionId"=$2 AND turn."userId"=$3 LIMIT 2`,
    [identity.fillTurnId, identity.sessionId, identity.userId, identity.applicationTaskId, identity.jobId]);
    if (turn.rows.length !== 1) return "blocked";
    const input = turn.rows[0]!.input;
    const objectiveSource = parseObjectiveReviewedFillSource(input);
    const selector = objectiveSource ? { kind: "objective" as const } : parseReviewedApplicationFillSource(input);
    if (selector.kind === "invalid") return "blocked";

    const [events, manifestEvidence] = await Promise.all([
      pool.query<{ present: boolean }>(`
      SELECT EXISTS (SELECT 1 FROM "application_task_events" AS event
        JOIN application_tasks AS task ON task."id"=event."taskId" AND task."userId"=$2
          AND task."jobId"=$3 AND task."sessionId"=$4 AND task."fillTurnId"=$5
        WHERE event."taskId"=$1 AND (event."type"='objective_application_review_approved'
          OR (event."type"='reviewed_application_fill_browser_started'
            AND (event."data"->>'schemaVersion'=$6 OR event."data" ? 'objectiveSource')))) AS present`,
      [identity.applicationTaskId, identity.userId, identity.jobId, identity.sessionId, identity.fillTurnId,
        OBJECTIVE_REVIEWED_FILL_BROWSER_START_SCHEMA]),
      (async () => {
        const { hasObjectiveSubmissionManifestEvidence } = await import("./objective-reviewed-application-submit-material.js");
        return hasObjectiveSubmissionManifestEvidence(pool, identity);
      })(),
    ]);
    if (events.rows.length !== 1 || typeof events.rows[0]?.present !== "boolean") return "blocked";
    const hasObjectiveEvidence = events.rows[0].present || manifestEvidence;
    if (selector.kind === "objective") return "objective";
    return hasObjectiveEvidence ? "blocked" : "ordinary";
  } catch {
    return "blocked";
  }
}

async function loadConfirmedAnswers(
  pool: Pool,
  taskId: string,
  userId: string,
  jobId: string,
): Promise<Record<string, string>> {
  const result = await pool.query(
    `SELECT "confirmedAnswers" FROM application_tasks
      WHERE id = $1 AND "userId" = $2 AND "jobId" = $3`,
    [taskId, userId, jobId],
  );
  const value: unknown = result.rows[0]?.confirmedAnswers;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] =>
      typeof entry[0] === "string" && typeof entry[1] === "string" && entry[1].trim().length > 0,
    ),
  );
}
