import { createHash } from "node:crypto";

export interface FormMappingArtifact {
  readonly type: "form_mapping";
  readonly version: 1;
  readonly hash: string;
  readonly source: "deterministic" | "pattern" | "ai";
  readonly mappings: Readonly<Record<string, string>>;
}

/** Build a stable, value-free artifact that can be reviewed or invalidated. */
export function createFormMappingArtifact(
  mappings: Record<string, string>,
  source: FormMappingArtifact["source"],
): FormMappingArtifact {
  const normalized = Object.fromEntries(
    Object.entries(mappings)
      .filter(([selector, field]) => selector.trim().length > 0 && field.trim().length > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const hash = createHash("sha256")
    .update(JSON.stringify({ version: 1, source, mappings: normalized }))
    .digest("hex");
  return { type: "form_mapping", version: 1, hash: `sha256:${hash}`, source, mappings: normalized };
}
