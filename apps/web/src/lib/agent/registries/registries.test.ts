import { describe, it, expect, beforeAll } from "vitest";
import { loadRegistry, filterEmployers, Employer } from "./index";

describe("registries", () => {
  describe("loadRegistry", () => {
    it("loads greenhouse registry with >= 30 entries", () => {
      const employers = loadRegistry("greenhouse");
      expect(employers.length).toBeGreaterThanOrEqual(30);
    });

    it("loads lever registry with >= 30 entries", () => {
      const employers = loadRegistry("lever");
      expect(employers.length).toBeGreaterThanOrEqual(30);
    });

    it("every greenhouse entry has all required fields", () => {
      const employers = loadRegistry("greenhouse");
      for (const e of employers) {
        expect(typeof e.slug).toBe("string");
        expect(e.slug.length).toBeGreaterThan(0);
        expect(typeof e.name).toBe("string");
        expect(e.name.length).toBeGreaterThan(0);
        expect(typeof e.country).toBe("string");
        expect(e.country).toMatch(/^[a-z]{2}$/);
        expect([1, 2, 3]).toContain(e.tier);
      }
    });

    it("every lever entry has all required fields", () => {
      const employers = loadRegistry("lever");
      for (const e of employers) {
        expect(typeof e.slug).toBe("string");
        expect(e.slug.length).toBeGreaterThan(0);
        expect(typeof e.name).toBe("string");
        expect(e.name.length).toBeGreaterThan(0);
        expect(typeof e.country).toBe("string");
        expect(e.country).toMatch(/^[a-z]{2}$/);
        expect([1, 2, 3]).toContain(e.tier);
      }
    });

    it("no duplicate slugs in greenhouse", () => {
      const employers = loadRegistry("greenhouse");
      const slugs = employers.map((e) => e.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
    });

    it("no duplicate slugs in lever", () => {
      const employers = loadRegistry("lever");
      const slugs = employers.map((e) => e.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
    });

    it("cache returns same reference on second call", () => {
      const a = loadRegistry("greenhouse");
      const b = loadRegistry("greenhouse");
      expect(a).toBe(b);
    });
  });

  describe("filterEmployers", () => {
    let employers: Employer[];

    beforeAll(() => {
      employers = loadRegistry("greenhouse");
    });

    it("returns all when no filters", () => {
      expect(filterEmployers(employers).length).toBe(employers.length);
    });

    it("filters by country", () => {
      const de = filterEmployers(employers, { countries: ["de"] });
      expect(de.length).toBeGreaterThan(0);
      for (const e of de) expect(e.country).toBe("de");
    });

    it("filters by tier", () => {
      const t1 = filterEmployers(employers, { tiers: [1] });
      expect(t1.length).toBeGreaterThan(0);
      for (const e of t1) expect(e.tier).toBe(1);
    });

    it("filters by country + tier combined", () => {
      const result = filterEmployers(employers, { countries: ["de"], tiers: [1] });
      expect(result.length).toBeGreaterThan(0);
      for (const e of result) {
        expect(e.country).toBe("de");
        expect(e.tier).toBe(1);
      }
    });

    it("empty filter arrays behave as no-filter", () => {
      expect(filterEmployers(employers, { countries: [] }).length).toBe(employers.length);
      expect(filterEmployers(employers, { tiers: [] }).length).toBe(employers.length);
    });
  });
});
