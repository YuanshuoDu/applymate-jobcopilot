import type { Pool } from "pg";
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

  return {
    persona: { ...base, ...learned },
    jobTitle: job.role ?? "",
    jobCompany: job.company ?? "",
    jobKeywords: job.keywords ?? "",
    applyUrl: job.url?.trim() || fallbackApplyUrl,
    coverLetterText: job.coverLetter ?? null,
    resumeTempPath,
  };
}
