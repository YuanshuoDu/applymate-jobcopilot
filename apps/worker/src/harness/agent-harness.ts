import type { Page } from "playwright-core";
import type { ApplyResult } from "@jobcopilot/shared";
import { loadWorkerAiConfig, callLlmText, type AiConfig } from "@jobcopilot/shared/llm";
import { perceiveFields, type PerceivedField } from "./dom-extractor.js";
import { createFormMappingArtifact, type FormMappingArtifact } from "../patterns/form-pattern-artifact.js";
import {
  buildSystemPrompt,
  buildUserMessage,
  parseAction,
  type AgentAction,
  type TurnLog,
} from "./harness-prompt.js";
import type { SubmissionGuard } from "../flows/helpers.js";

const SENSITIVE_FIELD = /salary|compensation|pay|visa|sponsor|work.?authori[sz]|citizen|nationality|legal|criminal|disability|gender|race|ethnic|signature|e-?sign/i;

/** Config passed to AgentHarness constructor */
export interface HarnessConfig {
  userId: string;
  maxTurns: number;
  dryRun: boolean;
  mode: "dom" | "vision" | "hybrid";
  /** Root Turn cancellation signal. The model cannot replace this signal. */
  signal?: AbortSignal;
  budget?: { maxActions?: number; maxAiCalls?: number };
  onItem?: (item: BrowserFillItem) => Promise<void> | void;
  onWait?: (wait: BrowserFillWaitRequest) => Promise<void> | void;
}

/** Task data passed to harness.run() */
export type HarnessResult = Pick<ApplyResult, "status" | "error" | "durationMs"> &
  Partial<Pick<ApplyResult, "id" | "userId" | "jobId" | "mode" | "atsType" | "flowUsed" | "createdAt">> & {
  turns?: number;
  log?: unknown[];
  fieldMappings?: Record<string, string>;
  mappingArtifact?: FormMappingArtifact;
  items?: BrowserFillItem[];
  classification?: BrowserFillClassification;
  waitReason?: BrowserFillWaitReason;
  /** The form was filled but intentionally not submitted. */
  reviewReady?: boolean;
};

export interface ApplyTask {
  jobId: string;
  applyUrl: string;
  persona: Record<string, string>;
  jobTitle: string;
  jobCompany: string;
  jobKeywords?: string;
  resumePath: string;
  coverLetterPath?: string;
  dryRun?: boolean;
  allowSubmit?: boolean;
  /** Re-evaluates runtime controls before a submit or generic click can advance a form. */
  beforeSubmit?: SubmissionGuard;
  /** Per-application values explicitly entered by the candidate after a pause. */
  confirmedAnswers?: Record<string, string>;
  /** Optional review material preflight; mismatches stop the fill before action. */
  review?: BrowserFillReview;
  /** Job description is untrusted reference data, never an instruction source. */
  jobDescription?: string;
}

export type BrowserFillWaitReason = "captcha" | "login_required" | "mfa_required" | "unknown_sensitive_field" | "stale_review";
export type BrowserFillClassification = "submit_blocked" | "waiting_for_user" | "budget_exhausted" | "cancelled" | "browser_crash" | "untrusted_input";
export interface BrowserFillReview {
  artifactHash?: string;
  currentArtifactHash?: string;
  formFingerprint?: string;
  currentFormFingerprint?: string;
  isCurrent?: () => Promise<boolean> | boolean;
}
export interface BrowserFillWaitRequest {
  reason: BrowserFillWaitReason;
  jobId: string;
  message: string;
}
export interface BrowserFillItem {
  id: string;
  type: "browser_action";
  phase: "started" | "completed" | "failed";
  action: AgentAction["type"];
  selector?: string;
  field?: string;
  value: "[REDACTED]" | null;
  errorCode?: string;
}

const SUCCESS_URL_PATTERNS = [
  /thank/i,
  /success/i,
  /confirmation/i,
  /submitted/i,
];

export class AgentHarness {
  private config: HarnessConfig;
  private turns: TurnLog[] = [];
  private aiConfig: AiConfig | null = null;
  private items: BrowserFillItem[] = [];
  private actionCount = 0;
  private aiCallCount = 0;

  constructor(config: HarnessConfig) {
    this.config = config;
  }

  /** Resolve AI config lazily (cached per instance) */
  private async getAiConfig(): Promise<AiConfig> {
    if (!this.aiConfig) {
      this.aiConfig = await loadWorkerAiConfig(this.config.userId);
    }
    return this.aiConfig;
  }

  /** Call the LLM with chat messages */
  private async callLLM(
    messages: Array<{ role: string; content: string }>
  ): Promise<string> {
    const config = await this.getAiConfig();
    return callLlmText(
      messages as Array<{ role: "system" | "user" | "assistant"; content: string }>,
      config,
      { userId: this.config.userId, featureKey: "autoApply", runtime: "worker" },
    );
  }

  /** Run the perception-action loop until termination. */
  async run(page: Page, task: ApplyTask): Promise<HarnessResult> {
    this.turns = [];
    this.items = [];
    this.actionCount = 0;
    this.aiCallCount = 0;
    const startedAt = Date.now();

    try {
      const systemPrompt = buildSystemPrompt(task.persona,
        {
          title: task.jobTitle,
          company: task.jobCompany,
          keywords: task.jobKeywords,
        },
        task.confirmedAnswers ?? {},
      );

      const messages: Array<{ role: string; content: string }> = [
        { role: "system", content: systemPrompt },
      ];

      for (let turn = 0; turn < this.config.maxTurns; turn++) {
        const turnStart = Date.now();
        this.assertActive();

        // ── Perceive ──
        let fields: PerceivedField[] = [];
        try {
          fields = await perceiveFields(page);
        } catch (err) {
          const logEntry: TurnLog = {
            turn,
            perceived: [],
            action: { type: "manual", reasoning: `DOM perception failed: ${err instanceof Error ? err.message : String(err)}` },
            durationMs: Date.now() - turnStart,
          };
          this.turns.push(logEntry);
          this.logTurn(logEntry);
          return this.buildResult("failed", task.jobId, Date.now() - startedAt, logEntry.action.reasoning, this.collectFieldMappings(), classifyBrowserFailure(err));
        }

        const url = page.url();

        const wait = await detectBrowserWait(page);
        if (wait) return await this.waitForUser(task.jobId, startedAt, wait.reason, wait.message);
        if (!(await isReviewCurrent(task.review, fields))) {
          return await this.waitForUser(task.jobId, startedAt, "stale_review", "The reviewed form or material is stale; review must be repeated.");
        }

        // ── Check URL-based success ──
        if (SUCCESS_URL_PATTERNS.some((p) => p.test(url))) {
          const fieldMappings = this.collectFieldMappings();
          const logEntry: TurnLog = {
            turn,
            perceived: fields,
            action: { type: "done", reasoning: `URL pattern match: ${url}` },
            durationMs: Date.now() - turnStart,
          };
          this.turns.push(logEntry);
          this.logTurn(logEntry);
          return this.buildResult("manual", task.jobId, Date.now() - startedAt, "Read-only fill completed on a success-looking page; submission was not verified.", fieldMappings, "submit_blocked");
        }

        // ── Decide ──
        const userMsg = buildUserMessage(fields, url, task.resumePath, task.coverLetterPath);
        messages.push({ role: "user", content: userMsg });

        let rawResponse: string;
        try {
          this.aiCallCount++;
          this.assertBudget("maxAiCalls", this.aiCallCount, this.config.budget?.maxAiCalls);
          rawResponse = await this.callLLM(messages);
          this.assertActive();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const logEntry: TurnLog = {
            turn,
            perceived: fields,
            action: { type: "manual", reasoning: `LLM call failed: ${msg}` },
            durationMs: Date.now() - turnStart,
          };
          this.turns.push(logEntry);
          this.logTurn(logEntry);
          return this.buildResult("failed", task.jobId, Date.now() - startedAt, msg, this.collectFieldMappings(), classifyBrowserFailure(err));
        }

        messages.push({ role: "assistant", content: rawResponse });

        const action = parseAction(rawResponse);
        if (!action) {
          const logEntry: TurnLog = {
            turn,
            perceived: fields,
            action: { type: "manual", reasoning: `Failed to parse LLM response: ${rawResponse.substring(0, 200)}` },
            durationMs: Date.now() - turnStart,
          };
          this.turns.push(logEntry);
          this.logTurn(logEntry);
          return this.buildResult("manual", task.jobId, Date.now() - startedAt, "LLM response parse failure");
        }

        const durationMs = Date.now() - turnStart;
        const logEntry: TurnLog = { turn, perceived: fields, action, durationMs };
        this.turns.push(logEntry);
        this.logTurn(logEntry);

        // ── Terminal actions ──
        if (action.type === "done") return this.buildReviewResult(task.jobId, Date.now() - startedAt);

        if (action.type === "submit") {
          return this.buildResult("manual", task.jobId, Date.now() - startedAt, "Read-only fill_form rejected a submit action.", this.collectFieldMappings(), "submit_blocked");
        }
        if (!isAllowedSensitiveAction(action, fields, task.confirmedAnswers)) {
          return await this.waitForUser(task.jobId, startedAt, "unknown_sensitive_field", "A sensitive form answer needs an explicit, matching candidate confirmation.");
        }
        if (!isTrustedActionValue(action, task, fields)) {
          return this.buildResult("manual", task.jobId, Date.now() - startedAt, "The model supplied a value that is not present in candidate data.", this.collectFieldMappings(), "untrusted_input");
        }
        if (action.type === "manual") {
          return this.buildResult("manual", task.jobId, Date.now() - startedAt, action.reasoning);
        }
        if (action.type === "click" && action.selector) {
          // Fill-only passes may still need safe clicks for custom controls
          // such as comboboxes. Keep the submit heuristic as the boundary so
          // those controls remain usable without enabling form submission.
          if (await clickMaySubmit(page, action.selector)) {
            return this.buildResult("manual", task.jobId, Date.now() - startedAt, "Read-only fill_form refused a submit-like click.", this.collectFieldMappings(), "submit_blocked");
          }
        }

        this.actionCount++;
        this.assertBudget("maxActions", this.actionCount, this.config.budget?.maxActions);
        await this.emitItem(action, "started");

        // ── Execute ──
        if (this.config.dryRun) {
          if (["fill", "click", "select", "upload", "submit"].includes(action.type)) {
            await this.emitItem(action, "completed");
            continue;
          }
        }

        try {
          await this.executeAction(page, action, task, fields);
          await this.emitItem(action, "completed");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const failEntry: TurnLog = {
            turn,
            perceived: fields,
            action: { type: "manual", reasoning: `Action execution failed: ${msg}` },
            durationMs: Date.now() - turnStart,
          };
          this.turns.push(failEntry);
          this.logTurn(failEntry);
          await this.emitItem(action, "failed", classifyBrowserFailure(err));
          return this.buildResult("failed", task.jobId, Date.now() - startedAt, msg, this.collectFieldMappings(), classifyBrowserFailure(err));
        }
      }

      return this.buildResult("failed", task.jobId, Date.now() - startedAt, `Max turns (${this.config.maxTurns}) reached`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const classification = isCancellation(err, this.config.signal) ? "cancelled" : classifyBrowserFailure(err);
      return this.buildResult("failed", task.jobId, Date.now() - startedAt, msg, this.collectFieldMappings(), classification);
    }
  }

  private async executeAction(page: Page, action: AgentAction, task: ApplyTask, fields: PerceivedField[]): Promise<void> {
    switch (action.type) {
      case "fill": {
        if (!action.selector || action.value === undefined) return;
        await this.humanType(page, action.selector, action.value);
        break;
      }
      case "click": {
        if (!action.selector) return;
        await page.click(action.selector);
        break;
      }
      case "select": {
        if (!action.selector || action.value === undefined) return;
        await page.selectOption(action.selector, action.value);
        break;
      }
      case "upload": {
        if (!action.selector) return;
        const filePath = uploadPathForField(action, fields, task);
        if (!filePath) return;
        await page.setInputFiles(action.selector, filePath);
        break;
      }
      case "scroll": {
        await page.evaluate(() => window.scrollBy(0, 400));
        break;
      }
      case "wait": {
        const ms = Math.min(Number(action.value) || 1000, 5000);
        await page.waitForTimeout(ms);
        break;
      }
      case "submit": {
        throw new Error("Read-only fill_form does not implement submit");
        break;
      }
    }
  }

  private async humanType(page: Page, selector: string, text: string): Promise<void> {
    await page.focus(selector);
    await page.fill(selector, "");
    for (const ch of text) {
      this.assertActive();
      await page.type(selector, ch, { delay: 50 + Math.random() * 70 });
    }
  }

  private buildResult(
    status: ApplyResult["status"],
    jobId: string,
    durationMs: number,
    error?: string,
    fieldMappings?: Record<string, string>,
    classification?: BrowserFillClassification,
  ): HarnessResult {
    const mappings = fieldMappings ?? this.collectFieldMappings();
    return {
      userId: this.config.userId,
      jobId,
      mode: "unattended",
      status,
      error: error ?? null,
      durationMs,
      ...(Object.keys(mappings).length > 0 ? { fieldMappings: mappings, mappingArtifact: createFormMappingArtifact(mappings, "ai") } : {}),
      items: [...this.items],
      log: [...this.items],
      ...(classification ? { classification } : {}),
    };
  }

  private buildReviewResult(jobId: string, durationMs: number): HarnessResult {
    return {
      ...this.buildResult("manual", jobId, durationMs, "Form filled and ready for user review.", this.collectFieldMappings()),
      reviewReady: true,
    };
  }

  private async waitForUser(jobId: string, startedAt: number, reason: BrowserFillWaitReason, message: string): Promise<HarnessResult> {
    const request = { reason, jobId, message };
    await Promise.resolve(this.config.onWait?.(request)).catch(() => undefined);
    return { ...this.buildResult("manual", jobId, Date.now() - startedAt, message, this.collectFieldMappings(), "waiting_for_user"), waitReason: reason };
  }

  private assertActive(): void {
    if (!this.config.signal?.aborted) return;
    throw this.config.signal.reason instanceof Error ? this.config.signal.reason : new Error("Browser fill was cancelled");
  }

  private assertBudget(metric: "maxActions" | "maxAiCalls", attempted: number, limit: number | undefined): void {
    if (limit !== undefined && attempted > limit) throw new Error(`Browser fill budget exhausted for ${metric}`);
  }

  private async emitItem(action: AgentAction, phase: BrowserFillItem["phase"], errorCode?: string): Promise<void> {
    const item: BrowserFillItem = {
      id: `browser-action:${this.items.length + 1}`,
      type: "browser_action",
      phase,
      action: action.type,
      ...(action.selector ? { selector: action.selector } : {}),
      ...(action.field && !SENSITIVE_FIELD.test(action.field) ? { field: action.field } : {}),
      value: action.value === undefined ? null : "[REDACTED]",
      ...(errorCode ? { errorCode } : {}),
    };
    this.items.push(item);
    await Promise.resolve(this.config.onItem?.(item)).catch(() => undefined);
  }

  private collectFieldMappings(): Record<string, string> {
    const fieldMappings: Record<string, string> = {};
    for (const turn of this.turns) {
      const action = turn.action;
      if (action.type === "fill" && action.selector && action.field) {
        fieldMappings[action.selector] = action.field;
      }
    }
    return fieldMappings;
  }

  private logTurn(log: TurnLog): void {
    // Worker logs are retained outside the task boundary. Keep selectors and
    // action types for debugging, but never persist candidate values, DOM
    // currentValue, free-form reasoning, or option text.
    console.log(JSON.stringify({
      turn: log.turn,
      durationMs: log.durationMs,
      perceived: log.perceived.map(field => ({
        selector: field.selector,
        type: field.type,
        label: field.label,
        required: field.required,
      })),
      action: { type: log.action.type, selector: log.action.selector, field: log.action.field },
    }));
  }
}

async function clickMaySubmit(page: Page, selector: string): Promise<boolean> {
  try {
    return await page.$eval(selector, (element) => {
      const tag = element.tagName.toLowerCase();
      const type = element.getAttribute("type")?.toLowerCase() ?? "";
      if (tag === "button" && (type === "submit" || (!type && element.closest("form")))) return true;
      if (tag === "input" && (type === "submit" || type === "image")) return true;
      const label = [
        element.textContent,
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("value"),
      ].filter(Boolean).join(" ");
      return /\b(submit|apply|send|complete|finish|confirm)\b/i.test(label);
    });
  } catch {
    // A selector that cannot be inspected is unsafe to execute after a revocation.
    return true;
  }
}

function isAllowedSensitiveAction(
  action: AgentAction,
  fields: PerceivedField[],
  confirmedAnswers: Record<string, string> | undefined,
): boolean {
  if (action.type !== "fill" && action.type !== "select") return true;
  const perceived = fields.find(field => field.selector === action.selector);
  const observedLabel = perceived?.label ?? action.field ?? "";
  if (!SENSITIVE_FIELD.test(observedLabel)) return true;
  return Object.entries(confirmedAnswers ?? {}).some(([label, value]) =>
    SENSITIVE_FIELD.test(label) && value === action.value && sameField(label, observedLabel),
  );
}

function sameField(left: string, right: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function uploadPathForField(action: AgentAction, fields: PerceivedField[], task: ApplyTask): string | undefined {
  const perceived = fields.find(field => field.selector === action.selector);
  const label = `${perceived?.label ?? ""} ${perceived?.type ?? ""}`.toLowerCase();
  if (/cover\s*letter|motivation|anschreiben/.test(label)) return task.coverLetterPath ?? task.resumePath;
  return task.resumePath;
}

async function isReviewCurrent(review: BrowserFillReview | undefined, fields: PerceivedField[]): Promise<boolean> {
  if (!review) return true;
  if (review.artifactHash !== undefined && review.artifactHash !== review.currentArtifactHash) return false;
  if (review.formFingerprint !== undefined && review.currentFormFingerprint !== undefined && review.formFingerprint !== review.currentFormFingerprint) return false;
  if (review.formFingerprint !== undefined && review.formFingerprint !== formFingerprint(fields)) return false;
  if (review.isCurrent && !(await review.isCurrent())) return false;
  return true;
}

function formFingerprint(fields: PerceivedField[]): string {
  return JSON.stringify(fields.map(field => ({ selector: field.selector, type: field.type, required: field.required })).sort((a, b) => a.selector.localeCompare(b.selector)));
}

function isTrustedActionValue(action: AgentAction, task: ApplyTask, fields: PerceivedField[]): boolean {
  if (action.type !== "fill" && action.type !== "select") return true;
  if (!action.selector || !fields.some(field => field.selector === action.selector)) return false;
  if (action.value === undefined) return false;
  const values = [...Object.values(task.persona), ...Object.values(task.confirmedAnswers ?? {})]
    .filter((value): value is string => typeof value === "string");
  return values.includes(action.value);
}

export async function detectBrowserWait(page: Page): Promise<{ reason: BrowserFillWaitReason; message: string } | null> {
  const candidate = page as Page & { textContent?: (selector: string) => Promise<string | null> };
  if (typeof candidate.locator !== "function" || typeof candidate.textContent !== "function") return null;
  try {
    const checks: Array<[BrowserFillWaitReason, string, string[]]> = [
      ["captcha", "CAPTCHA detected. User takeover is required; no bypass was attempted.", [".g-recaptcha", ".h-captcha", "[data-sitekey]", 'iframe[src*="challenges.cloudflare.com"]']],
      ["login_required", "Login is required. User takeover is required; no credentials were guessed.", ["input[type='password']", "form[action*='login' i]"]],
      ["mfa_required", "MFA is required. User takeover is required; no verification code was guessed.", ["input[name*='otp' i]", "input[name*='code' i]", "input[autocomplete='one-time-code']"]],
    ];
    for (const [reason, message, selectors] of checks) {
      for (const selector of selectors) if (await candidate.locator(selector).count()) return { reason, message };
    }
    const text = await candidate.textContent("body");
    if (/captcha|verify you are human/i.test(text ?? "")) return { reason: "captcha", message: "CAPTCHA detected. User takeover is required; no bypass was attempted." };
    if (/log[ -]?in|sign[ -]?in/i.test(text ?? "") && /password|credential/i.test(text ?? "")) return { reason: "login_required", message: "Login is required. User takeover is required; no credentials were guessed." };
    if (/multi[ -]?factor|two[ -]?factor|2fa|verification code|one[- ]time password/i.test(text ?? "")) return { reason: "mfa_required", message: "MFA is required. User takeover is required; no verification code was guessed." };
  } catch {
    return { reason: "captcha", message: "Browser challenge detection failed. User takeover is required; no bypass was attempted." };
  }
  return null;
}

function isCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  return Boolean(signal?.aborted) || (error instanceof Error && /cancel|abort|interrupt/i.test(error.message));
}

function classifyBrowserFailure(error: unknown): BrowserFillClassification | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (/budget exhausted/i.test(message)) return "budget_exhausted";
  if (/browser|page|target closed|execution context|protocol|connection/i.test(message)) return "browser_crash";
  return undefined;
}
