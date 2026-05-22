import type { Pool } from "pg";

export interface TaskContext {
  persona: Record<string, string>;
  jobTitle: string;
  jobCompany: string;
  jobKeywords: string;
  applyUrl: string;
  coverLetterText: string | null;
}

export async function loadTaskContext(
  pool: Pool,
  userId: string,
  jobId: string,
  fallbackApplyUrl: string,
): Promise<TaskContext> {
  const [userRes, jobRes] = await Promise.all([
    pool.query(
      'SELECT name, email, phone, location, linkedin, "personaFields" FROM "User" WHERE id = $1',
      [userId]
    ),
    pool.query(
      'SELECT role, company, keywords, description, url, "coverLetter" FROM "Job" WHERE id = $1 AND "userId" = $2',
      [jobId, userId]
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

  return {
    persona: { ...base, ...learned },
    jobTitle: job.role ?? "",
    jobCompany: job.company ?? "",
    jobKeywords: job.keywords ?? "",
    applyUrl: job.url?.trim() || fallbackApplyUrl,
    coverLetterText: job.coverLetter ?? null,
  };
}
