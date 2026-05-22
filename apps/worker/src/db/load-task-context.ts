import type { Pool } from "pg";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TaskContext {
  persona: Record<string, string>;
  jobTitle: string;
  jobCompany: string;
  jobKeywords: string;
  applyUrl: string;
  coverLetterText: string | null;
  resumeTempPath?: string;
}

interface ResumeContent {
  personalInfo?: { fullName?: string; email?: string; phone?: string; location?: string; linkedinUrl?: string };
  summary?: string;
  skills?: Array<{ name?: string } | string>;
  experience?: Array<{ title?: string; company?: string; startDate?: string; endDate?: string; description?: string }>;
  education?: Array<{ school?: string; degree?: string; field?: string; startDate?: string; endDate?: string }>;
}

function resumeToText(c: ResumeContent): string {
  const lines: string[] = [];
  if (c.personalInfo?.fullName) lines.push(c.personalInfo.fullName);
  if (c.personalInfo?.email) lines.push(c.personalInfo.email);
  if (c.personalInfo?.phone) lines.push(c.personalInfo.phone);
  if (c.personalInfo?.location) lines.push(c.personalInfo.location);
  if (c.personalInfo?.linkedinUrl) lines.push(c.personalInfo.linkedinUrl);
  if (c.summary) { lines.push(""); lines.push("SUMMARY"); lines.push(c.summary); }
  if (c.skills?.length) {
    lines.push("");
    lines.push("SKILLS");
    for (const s of c.skills) lines.push(typeof s === "string" ? s : (s.name ?? ""));
  }
  if (c.experience?.length) {
    lines.push("");
    lines.push("EXPERIENCE");
    for (const e of c.experience) lines.push(`${e.title ?? ""} at ${e.company ?? ""} (${e.startDate ?? ""} - ${e.endDate ?? ""})`);
  }
  if (c.education?.length) {
    lines.push("");
    lines.push("EDUCATION");
    for (const ed of c.education) lines.push(`${ed.degree ?? ""} in ${ed.field ?? ""} — ${ed.school ?? ""}`);
  }
  return lines.join("\n");
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

  // Export default resume to temp .txt file for file uploads
  let resumeTempPath: string | undefined;
  if (resumeRes.rows[0]?.content) {
    const content = resumeRes.rows[0].content as ResumeContent;
    const text = resumeToText(content);
    resumeTempPath = join(tmpdir(), `resume-${userId}-${Date.now()}.txt`);
    writeFileSync(resumeTempPath, text, "utf-8");
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
