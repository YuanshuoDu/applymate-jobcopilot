import { describe, it, expect } from "vitest";
import { detectFlow } from "./index.js";

describe("detectFlow", () => {
  it("detects greenhouse URLs", () => {
    expect(detectFlow("https://boards.greenhouse.io/booking/jobs/123")).toBe("greenhouse");
    expect(detectFlow("https://grnh.se/abc123")).toBe("greenhouse");
    expect(detectFlow("https://greenhouse.io/applications/789")).toBe("greenhouse");
  });

  it("detects lever URLs", () => {
    expect(detectFlow("https://jobs.lever.co/spotify/abc")).toBe("lever");
    expect(detectFlow("https://jobs.eu.lever.co/klarna/xyz")).toBe("lever");
  });

  it("detects workday URLs", () => {
    expect(detectFlow("https://siemens.wd3.myworkdayjobs.com/Siemens")).toBe("workday");
  });

  it("detects smartrecruiters URLs", () => {
    expect(detectFlow("https://jobs.smartrecruiters.com/Visa/123-engineer")).toBe("smartrecruiters");
    expect(detectFlow("https://JOBS.SMARTRECRUITERS.COM/Bosch/456")).toBe("smartrecruiters");
  });

  it("detects personio URLs", () => {
    expect(detectFlow("https://flixbus.jobs.personio.com/job/123")).toBe("personio");
    expect(detectFlow("https://trade-republic.jobs.personio.com/xml")).toBe("personio");
    expect(detectFlow("https://FLIXBUS.JOBS.PERSONIO.COM/job/456")).toBe("personio");
  });

  it("returns null for unknown URLs", () => {
    expect(detectFlow("https://linkedin.com/jobs/view/123")).toBeNull();
    expect(detectFlow("https://indeed.com/viewjob?jk=abc")).toBeNull();
    expect(detectFlow("https://jobs.example.com/123")).toBeNull();
    expect(detectFlow("")).toBeNull();
  });
});
