import type { Pool } from "pg";
import { callLlm, loadWorkerAiConfig } from "@jobcopilot/shared";
import { generateResumePdf, type ResumeContent } from "./resume-pdf.js";
import { tailorResumeKeywords } from "./tailor-resume.js";

export interface TaskContext {
  persona: Record<string, string>;
  jobTitle: string;
  jobCompany: string;
  jobKeywords: string;
  applyUrl: string;
  coverLetterText: string | null;
  resumeTempPath?: string;
}

export async function loadTaskContext(
  pool: Pool,
  userId: string,
  jobId: string,
  fallbackApplyUrl: string,
): Promise<TaskContext> {
  const [userRes, jobRes, resumeRes] = await Promise.all([
    pool.query(
      'SELECT name, email, phone, location, linkedin, "personaFields" FROM "User" WHERE id = $1',
      [userId]
    ),
    pool.query(
      'SELECT role, company, keywords, description, url, "coverLetter" FROM "Job" WHERE id = $1 AND "userId" = $2',
      [jobId, userId]
    ),
    pool.query(
      'SELECT content FROM "Resume" WHERE "userId" = $1 AND "isDefault" = true LIMIT 1',
      [userId]
    ),
  ]);

  if (!jobRes.rows[0]) {
    throw new Error(`Job ${jobId} not found for user ${userId}`);
  }

  const user = userRes.rows[0] ?? {};
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

  // Export default resume to temp PDF file for file uploads
  let resumeTempPath: string | undefined;
  if (resumeRes.rows[0]?.content) {
    const baseContent = resumeRes.rows[0].content as ResumeContent;
    // Tailor skills section with missing JD keywords (improves ATS pass rate)
    const tailored = job.keywords
      ? tailorResumeKeywords(baseContent, job.keywords)
      : baseContent;
    resumeTempPath = await generateResumePdf(userId, tailored);
  }

  const persona: Record<string, string> = { ...base, ...learned };

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
        aiConfig
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
    applyUrl: job.url?.trim() || fallbackApplyUrl,
    coverLetterText,
    resumeTempPath,
  };
}
