import { describe, it, expect, afterEach } from "vitest";
import { ensureProfileDir, storageStatePath, removeProfileDir } from "./profiles.js";
import fs from "node:fs";

const TEST_USER = "test-user-profile";

describe("profiles", () => {
  afterEach(() => {
    removeProfileDir(TEST_USER);
  });

  it("ensureProfileDir creates a directory", () => {
    const dir = ensureProfileDir(TEST_USER);
    expect(fs.existsSync(dir)).toBe(true);
    expect(dir).toContain(TEST_USER);
  });

  it("storageStatePath returns the state.json path", () => {
    const sp = storageStatePath(TEST_USER);
    expect(sp).toContain("state.json");
    expect(sp).toContain(TEST_USER);
  });

  it("removeProfileDir cleans up", () => {
    ensureProfileDir(TEST_USER);
    expect(fs.existsSync(storageStatePath(TEST_USER))).toBe(false);
    fs.writeFileSync(storageStatePath(TEST_USER), "{}", "utf-8");
    expect(fs.existsSync(storageStatePath(TEST_USER))).toBe(true);
    removeProfileDir(TEST_USER);
    expect(fs.existsSync(storageStatePath(TEST_USER))).toBe(false);
  });
});
