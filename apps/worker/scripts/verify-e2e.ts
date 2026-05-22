/**
 * End-to-end verification: AgentHarness simulate a full Greenhouse application.
 * Runs the complete perception-action loop with mock Page + mock LLM.
 */
import { AgentHarness } from "../src/harness/agent-harness.js";
import type { Page } from "playwright-core";

// ── Mock a realistic Greenhouse application form ──

const GREENHOUSE_FIELDS = [
  // Screen 1: Personal info
  [
    { selector: "#first_name", type: "text", label: "First Name", required: true, currentValue: "", options: undefined },
    { selector: "#last_name", type: "text", label: "Last Name", required: true, currentValue: "", options: undefined },
    { selector: "#email", type: "email", label: "Email", required: true, currentValue: "", options: undefined },
    { selector: "#phone", type: "tel", label: "Phone", required: false, currentValue: "", options: undefined },
  ],
  // Screen 2: Location + resume
  [
    { selector: "#job_application_location", type: "text", label: "Location", required: true, currentValue: "", options: undefined },
    { selector: "#resume", type: "file", label: "Resume/CV", required: true, currentValue: "", options: undefined },
    { selector: "#cover_letter", type: "file", label: "Cover Letter", required: false, currentValue: "", options: undefined },
  ],
  // Screen 3: Work authorization
  [
    { selector: "#work_authorization", type: "select", label: "Are you authorized to work in the EU?", required: true, currentValue: "", options: ["Yes", "No", "Will require sponsorship"] },
    { selector: "#notice_period", type: "select", label: "Notice Period", required: false, currentValue: "", options: ["Immediate", "2 weeks", "1 month", "3 months"] },
  ],
  // Screen 4: Demographic (optional) — agent should click next
  [
    { selector: "#gender", type: "select", label: "Gender (optional)", required: false, currentValue: "", options: ["Male", "Female", "Non-binary", "Prefer not to say"] },
  ],
];

const URLS = [
  "https://boards.greenhouse.io/booking/jobs/12345/applications/new",
  "https://boards.greenhouse.io/booking/jobs/12345/applications/new#step=2",
  "https://boards.greenhouse.io/booking/jobs/12345/applications/new#step=3",
  "https://boards.greenhouse.io/booking/jobs/12345/applications/new#step=4",
  "https://boards.greenhouse.io/booking/confirmation?status=submitted",
];

let fieldIdx = 0;
let urlIdx = 0;

function mockPage(): Page {
  return {
    url: () => URLS[urlIdx] ?? URLS[URLS.length - 1],
    evaluate: async () => {
      const fields = GREENHOUSE_FIELDS[fieldIdx] ?? [];
      console.log(`  [mock:page] Returning ${fields.length} fields from screen ${fieldIdx + 1}`);
      return fields;
    },
    focus: async () => {},
    fill: async () => {},
    type: async () => { urlIdx = Math.min(urlIdx + 1, URLS.length - 1); },
    click: async (sel: string) => {
      if (sel?.includes("submit") || sel?.includes("next")) {
        fieldIdx = Math.min(fieldIdx + 1, GREENHOUSE_FIELDS.length - 1);
        urlIdx = Math.min(urlIdx + 1, URLS.length - 1);
        console.log(`  [mock:page] Clicked "${sel}" → advancing to screen ${fieldIdx + 1}`);
      }
    },
    selectOption: async () => {},
    setInputFiles: async () => {},
    waitForTimeout: async () => {},
    waitForURL: async () => {},
  } as unknown as Page;
}

// ── Mock LLM that returns intelligent actions ──

const LLM_RESPONSES = [
  // Screen 1: fill personal fields, click next
  '{"type": "fill", "selector": "#first_name", "value": "Jean", "reasoning": "Fill first name from candidate data"}',
  '{"type": "fill", "selector": "#last_name", "value": "Dupont", "reasoning": "Fill last name from candidate data"}',
  '{"type": "fill", "selector": "#email", "value": "jean.dupont@email.fr", "reasoning": "Fill email from candidate data"}',
  '{"type": "click", "selector": "#submit_app", "reasoning": "All personal fields filled, advance to next screen"}',
  // Screen 2: fill location, upload files, click next
  '{"type": "fill", "selector": "#job_application_location", "value": "Paris, France", "reasoning": "Fill location from candidate data"}',
  '{"type": "upload", "selector": "#resume", "filePath": "/resumes/jean-dupont.pdf", "reasoning": "Upload resume"}',
  '{"type": "click", "selector": "#next_button", "reasoning": "All fields filled, advance"}',
  // Screen 3: select work authorization, notice period, submit
  '{"type": "select", "selector": "#work_authorization", "value": "Yes", "reasoning": "Candidate is EU citizen, authorized to work"}',
  '{"type": "select", "selector": "#notice_period", "value": "1 month", "reasoning": "Standard notice period"}',
  '{"type": "click", "selector": "#submit_application", "reasoning": "All required fields filled, submit application"}',
];

let llmIdx = 0;

// ── Run ──

console.log("=".repeat(60));
console.log("END-TO-END VERIFICATION: AgentHarness → Greenhouse Application");
console.log("=".repeat(60));
console.log("");

const harness = new AgentHarness({
  userId: "verify-user",
  maxTurns: 15,
  dryRun: true,   // dry-run: don't actually fill/submit
  mode: "dom",
});

// Override callLLM by directly patching the harness
(harness as any).callLLM = async () => {
  const r = LLM_RESPONSES[llmIdx] ?? '{"type": "done", "reasoning": "Application submitted — confirmation page detected"}';
  llmIdx++;
  return r;
};

// Override getAiConfig to skip DB
(harness as any).getAiConfig = async () => ({
  provider: "minimax",
  model: "MiniMax-M2.7",
});

const result = await harness.run(mockPage(), {
  jobId: "greenhouse-12345",
  applyUrl: "https://boards.greenhouse.io/booking/jobs/12345/applications/new",
  persona: {
    fullName: "Jean Dupont",
    email: "jean.dupont@email.fr",
    phone: "+33 6 12 34 56 78",
    location: "Paris, France",
    skills: ["TypeScript", "React", "Node.js", "PostgreSQL"],
    experience: [{ title: "Senior Full-Stack Engineer", company: "TechCorp", startDate: "2020-01", endDate: "2025-05" }],
    education: [{ school: "Sorbonne Université", degree: "Master", field: "Computer Science", graduationDate: "2019" }],
  },
  jobTitle: "Senior Software Engineer",
  jobCompany: "Booking.com",
  jobKeywords: "TypeScript, React, Node.js, PostgreSQL, AWS, Docker, Kubernetes",
  resumePath: "/resumes/jean-dupont.pdf",
  coverLetterPath: "/resumes/jean-dupont-cover.pdf",
});

console.log("");
console.log("=".repeat(60));
console.log("RESULT");
console.log("=".repeat(60));
console.log(JSON.stringify(result, null, 2));

const passed = result.status === "submitted" || result.status === "dry-run";
console.log("");
console.log(passed ? "✅ END-TO-END VERIFICATION PASSED" : "❌ VERIFICATION FAILED");
console.log(`   Status: ${result.status}`);
console.log(`   Duration: ${result.durationMs}ms`);
console.log(`   LLM calls: ${llmIdx}`);
console.log(`   Total turns: ${(harness as any).turns?.length ?? "N/A"}`);

process.exit(passed ? 0 : 1);
