import { describe, expect, it } from "vitest"
import { matchObjectiveJourneySkillLabels, normalizeObjectiveJourneySkillLabel, parseConfirmedPastedSkills } from "./objective-journey-skill-labels"

describe("objective journey skill labels", () => {
  it("accepts only keyword labels with one whole literal occurrence in verified quotes", () => {
    expect(matchObjectiveJourneySkillLabels("TypeScript, Rust", ["Build services in TypeScript."])).toEqual([
      { label: "TypeScript", normalizedLabel: "typescript" },
    ])
    expect(matchObjectiveJourneySkillLabels("typescript", ["Build services in TYPESCRIPT."])).toEqual([
      { label: "typescript", normalizedLabel: "typescript" },
    ])
  })

  it("rejects substring matches and ambiguous repeated mentions", () => {
    expect(matchObjectiveJourneySkillLabels("Go, Rust", ["Google services and Go tooling."])).toEqual([
      { label: "Go", normalizedLabel: "go" },
    ])
    expect(matchObjectiveJourneySkillLabels("Rust", ["Rust and Rust are required."])).toEqual([])
    expect(matchObjectiveJourneySkillLabels("Java", ["JavaScript is used here."])).toEqual([])
    expect(matchObjectiveJourneySkillLabels("Java", ["JavaScript and Java are used here."])).toEqual([
      { label: "Java", normalizedLabel: "java" },
    ])
    expect(matchObjectiveJourneySkillLabels("C", ["Experience with C++ and C#."])).toEqual([])
    expect(matchObjectiveJourneySkillLabels("F", ["Experience with F/F#."])).toEqual([])
    expect(matchObjectiveJourneySkillLabels("Node", ["Node.js is used here."])).toEqual([])
    expect(matchObjectiveJourneySkillLabels("Node", ["Node. is used here."])).toEqual([
      { label: "Node", normalizedLabel: "node" },
    ])
  })

  it("keeps valid candidates when another Job keyword is malformed", () => {
    expect(matchObjectiveJourneySkillLabels("Rust, rust, https://example.com, System Design", ["Rust and System Design"])).toEqual([
      { label: "Rust", normalizedLabel: "rust" },
      { label: "System Design", normalizedLabel: "system design" },
    ])
    expect(matchObjectiveJourneySkillLabels("Rust,\nunsafe", ["Rust unsafe"])).toEqual([])
    expect(matchObjectiveJourneySkillLabels("", ["Rust"])).toEqual([])
  })

  it("parses only the current confirmed pasted Skills field", () => {
    expect(parseConfirmedPastedSkills("TypeScript, SQL", "typescript, sql")).toEqual(["TypeScript", "SQL"])
    expect(parseConfirmedPastedSkills("System Design, Technical Support, Team Leadership",
      "system design, technical support, team leadership")).toEqual(["System Design", "Technical Support", "Team Leadership"])
    expect(parseConfirmedPastedSkills("TypeScript, SQL", "typescript")).toBeUndefined()
    expect(parseConfirmedPastedSkills("TypeScript, typescript", "typescript, typescript")).toBeUndefined()
    expect(parseConfirmedPastedSkills("Must know TypeScript", "must know typescript")).toBeUndefined()
    expect(parseConfirmedPastedSkills("https://example.com", "https://example.com")).toBeUndefined()
    expect(parseConfirmedPastedSkills("name@example.com", "name@example.com")).toBeUndefined()
  })

  it("accepts punctuation-bearing and Unicode skill names", () => {
    expect(matchObjectiveJourneySkillLabels(".NET, C++, C#, CI/CD, 机器学习", [
      "Build .NET services with C++, C#, CI/CD and 机器学习.",
    ])).toEqual([
      { label: ".NET", normalizedLabel: ".net" },
      { label: "C++", normalizedLabel: "c++" },
      { label: "C#", normalizedLabel: "c#" },
      { label: "CI/CD", normalizedLabel: "ci/cd" },
      { label: "机器学习", normalizedLabel: "机器学习" },
    ])
  })

  it("normalizes case, compatibility forms, and whitespace for exact comparison", () => {
    expect(normalizeObjectiveJourneySkillLabel("  Ｎｏｄｅ.js  ")).toBe("node.js")
  })
})
