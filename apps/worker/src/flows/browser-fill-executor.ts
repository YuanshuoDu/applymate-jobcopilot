import { assertValid, schemaVersion } from "@jobcopilot/agent-protocol";
import { Type, type Static } from "@sinclair/typebox";
import type { Page } from "playwright-core";
import type { AtsSourceKey } from "@jobcopilot/shared/ats-url";
import { runGreenhouseFlow } from "./greenhouse-flow.js";
import { runLeverFlow } from "./lever-flow.js";
import { runPersonioFlow } from "./personio-flow.js";
import { runSmartRecruitersFlow } from "./smartrecruiters-flow.js";
import { runWorkdayFlow } from "./workday-flow.js";
import { AgentHarness, detectBrowserWait, type ApplyTask, type HarnessConfig, type HarnessResult } from "../harness/agent-harness.js";
import { replayPatternForReview } from "../patterns/replay.js";
import type { FormPatternRow } from "../db/form-patterns.js";
import { selectFillStrategy } from "../patterns/selector.js";
import { createFormMappingArtifact } from "../patterns/form-pattern-artifact.js";

const AtsTypeSchema = Type.Union([Type.Literal("greenhouse"), Type.Literal("lever"), Type.Literal("workday"), Type.Literal("personio"), Type.Literal("smartrecruiters")]);

/** Model-visible input. `submit` is literally false when present. */
export const FillFormInputSchema = Type.Object({
  jobId: Type.String({ minLength: 1, maxLength: 256 }),
  applyUrl: Type.String({ minLength: 1, maxLength: 2048 }),
  atsType: Type.Optional(Type.Union([AtsTypeSchema, Type.Null()])),
  persona: Type.Record(Type.String({ minLength: 1 }), Type.String()),
  jobTitle: Type.String({ maxLength: 256 }),
  jobCompany: Type.String({ maxLength: 256 }),
  jobKeywords: Type.Optional(Type.String({ maxLength: 8000 })),
  jobDescription: Type.Optional(Type.String({ maxLength: 20000 })),
  resumePath: Type.String({ minLength: 1, maxLength: 2048 }),
  coverLetterPath: Type.Optional(Type.String({ maxLength: 2048 })),
  dryRun: Type.Optional(Type.Boolean()),
  review: Type.Optional(Type.Object({
    artifactHash: Type.Optional(Type.String()), currentArtifactHash: Type.Optional(Type.String()),
    formFingerprint: Type.Optional(Type.String()), currentFormFingerprint: Type.Optional(Type.String()),
  }, { additionalProperties: false })),
  submit: Type.Optional(Type.Literal(false)),
}, { additionalProperties: false, $id: "browser.fill_form.v1" });

export type FillFormInput = Static<typeof FillFormInputSchema>;
export const FILL_FORM_TOOL = { schemaVersion, name: "browser.fill_form", version: "1", submit: false as const };

export interface BrowserFillExecutorContext {
  page: Page;
  pattern?: FormPatternRow | null;
  aiAvailable?: boolean;
  harnessConfig?: Omit<HarnessConfig, "dryRun" | "mode" | "maxTurns">;
}

export function parseFillFormInput(input: unknown): FillFormInput {
  assertValid(FillFormInputSchema, input, "browser.fill_form input");
  const value = input as FillFormInput;
  if ((value as { submit?: unknown }).submit === true) throw new Error("browser.fill_form cannot enable submit");
  return value;
}

/** Execute fill-for-review only; no branch in this function calls submit. */
export async function executeBrowserFill(input: unknown, context: BrowserFillExecutorContext): Promise<HarnessResult> {
  const value = parseFillFormInput(input);
  const strategy = selectFillStrategy({ atsType: value.atsType, pattern: context.pattern, aiAvailable: context.aiAvailable });
  const task: ApplyTask = {
    jobId: value.jobId, applyUrl: value.applyUrl, persona: value.persona, jobTitle: value.jobTitle,
    jobCompany: value.jobCompany, jobKeywords: value.jobKeywords, jobDescription: value.jobDescription,
    resumePath: value.resumePath, coverLetterPath: value.coverLetterPath, dryRun: value.dryRun,
    review: value.review,
  };

  if (strategy.kind === "budget") return { status: "manual", error: "AI fallback budget exhausted.", durationMs: 0, classification: "budget_exhausted", reviewReady: false };
  const wait = await detectBrowserWait(context.page);
  if (wait) {
    await Promise.resolve(context.harnessConfig?.onWait?.({ reason: wait.reason, jobId: value.jobId, message: wait.message })).catch(() => undefined);
    return { status: "manual", error: wait.message, durationMs: 0, classification: "waiting_for_user", waitReason: wait.reason };
  }
  if (strategy.kind === "pattern") return replayPatternForReview(context.page, strategy.pattern, value.persona);
  if (strategy.kind === "deterministic") return withDeterministicEvidence(await runDeterministicFlow(strategy.atsType, context.page, task));

  const harness = new AgentHarness({
    userId: context.harnessConfig?.userId ?? "runtime",
    maxTurns: 30,
    dryRun: value.dryRun ?? false,
    mode: "dom",
    ...context.harnessConfig,
  });
  return harness.run(context.page, task);
}

function withDeterministicEvidence(result: HarnessResult): HarnessResult {
  const mappings: Record<string, string> = {};
  const items = (result.log ?? []).flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") return [];
    const value = entry as { selector?: unknown; field?: unknown; action?: unknown };
    const selector = typeof value.selector === "string" ? value.selector : undefined;
    const field = typeof value.field === "string" ? value.field : undefined;
    if (selector && field) mappings[selector] = field;
    return [{ id: `browser-action:${index + 1}`, type: "browser_action" as const, phase: "completed" as const, action: typeof value.action === "string" ? "fill" as const : "wait" as const, ...(selector ? { selector } : {}), ...(field ? { field } : {}), value: "[REDACTED]" as const }];
  });
  return { ...result, ...(Object.keys(mappings).length ? { fieldMappings: mappings, mappingArtifact: createFormMappingArtifact(mappings, "deterministic") } : {}), ...(items.length ? { items } : {}) };
}

async function runDeterministicFlow(atsType: AtsSourceKey, page: Page, task: ApplyTask): Promise<HarnessResult> {
  switch (atsType) {
    case "greenhouse": return runGreenhouseFlow(page, task);
    case "lever": return runLeverFlow(page, task);
    case "workday": return runWorkdayFlow(page, task);
    case "personio": return runPersonioFlow(page, task);
    case "smartrecruiters": return runSmartRecruitersFlow(page, task);
  }
  throw new Error(`Unsupported deterministic ATS flow: ${atsType}`);
}
