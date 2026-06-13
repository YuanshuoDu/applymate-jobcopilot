import type { PerceivedField } from "./dom-extractor.js";

/** Job context passed to the harness */
export interface JobContext {
  title: string;
  company: string;
  keywords?: string;
}

/** Persona data (minimal subset — full persona injected via JSON) */
export interface PersonaData {
  fullName?: string;
  email?: string;
  phone?: string;
  location?: string;
  summary?: string;
  skills?: string[];
  experience?: Array<{
    title: string;
    company: string;
    startDate: string;
    endDate?: string;
    description?: string;
  }>;
  education?: Array<{
    school: string;
    degree: string;
    field: string;
    graduationDate?: string;
  }>;
  [key: string]: unknown;
}

/** Messages array for the ChatMessage API */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const SYSTEM_PROMPT = `You are an autonomous job application agent. Your job is to fill out a web form accurately using ONLY the candidate's provided data.

RULES:
1. Fill every required field visible on the current page.
2. For file upload fields: use the exact file path provided (resumePath, coverLetterPath).
3. NEVER guess or fabricate values not in the candidate data. Leave unknown fields empty.
4. When all visible fields on the current page are filled, click Next/Submit to advance.
5. If you see a CAPTCHA, login-wall, or error message you cannot resolve, return type: 'manual'.
6. Work ONE page at a time. Each turn you see only the current page's fields.
7. Return ONLY valid JSON matching the exact AgentAction schema below.
8. For select/dropdown fields, choose the option that BEST matches the candidate's data.

ACTION SCHEMA (return exactly this JSON):
{
  "type": "fill" | "click" | "select" | "upload" | "scroll" | "wait" | "submit" | "done" | "manual",
  "selector": "CSS selector for the target element (required for fill/click/select/upload/submit)",
  "value": "value to fill/select (required for fill/select/upload)",
  "field": "candidate data key used for fill actions, e.g. fullName, email, phone, location, summary",
  "reasoning": "brief explanation of why you chose this action"
}`;

/**
 * Build the system prompt with the candidate's persona and job context.
 */
export function buildSystemPrompt(persona: PersonaData, job: JobContext): string {
  const personaStr = JSON.stringify(persona, null, 2);
  const keywordsStr = job.keywords ?? "";

  return `${SYSTEM_PROMPT}

CANDIDATE DATA:
${personaStr}

JOB CONTEXT:
Title: ${job.title}
Company: ${job.company}
${keywordsStr ? `Key Requirements: ${keywordsStr}` : ""}
Cover Letter (if field exists): ${persona.coverLetter ?? "not provided"}
`;
}

/**
 * Build the user message describing the current page's perceived fields.
 */
export function buildUserMessage(
  fields: PerceivedField[],
  url: string,
  resumePath?: string,
  coverLetterPath?: string
): string {
  const fieldsJson = JSON.stringify(fields, null, 2);

  let msg = `CURRENT PAGE URL: ${url}\n\n`;
  msg += `PERCEIVED FIELDS (${fields.length} total):\n${fieldsJson}\n\n`;

  if (resumePath) {
    msg += `FILE PATHS:\n- Resume: ${resumePath}\n`;
  }
  if (coverLetterPath) {
    msg += `${resumePath ? "" : "FILE PATHS:\n"}- Cover Letter: ${coverLetterPath}\n`;
  }

  msg += `\nINSTRUCTIONS: Analyze the fields above and return ONE AgentAction JSON object. `;
  msg += `If all fields on this page are filled and you see a submit/next button, click it. `;
  msg += `If the application appears complete, return {"type": "done"}.`;

  return msg;
}

/**
 * Parse the LLM's JSON response into an AgentAction.
 */
export function parseAction(raw: string): AgentAction | null {
  try {
    // Strip markdown fences if present
    let cleaned = raw.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    }
    const parsed = JSON.parse(cleaned);
    if (!parsed.type) return null;
    return {
      type: parsed.type,
      selector: parsed.selector,
      value: parsed.value,
      field: parsed.field,
      filePath: parsed.filePath,
      reasoning: parsed.reasoning ?? "",
    };
  } catch {
    return null;
  }
}

/** LLM decision output */
export interface AgentAction {
  type: "fill" | "click" | "select" | "upload" | "scroll" | "wait" | "submit" | "done" | "manual";
  selector?: string;
  value?: string;
  field?: string;
  filePath?: string;
  reasoning: string;
}

/** Log entry for each turn */
export interface TurnLog {
  turn: number;
  perceived: PerceivedField[];
  action: AgentAction;
  durationMs: number;
}
