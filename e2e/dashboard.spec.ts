import { expect, test } from "./fixtures";

test.skip(
  !process.env.E2E_BASE_URL && !process.env.DATABASE_URL,
  "Set DATABASE_URL for the seeded demo user or E2E_BASE_URL for an already-running seeded app.",
);

test("login -> dashboard -> search jobs -> save one -> saved list", async ({ app, page }) => {
  await app.installMocks();
  await app.login();

  await app.goTo(/Search|搜索/);
  await page.getByPlaceholder(/Search jobs/).fill("Backend Engineer Dublin");
  await page.getByRole("button", { name: /^Search$/ }).click();

  await expect(page.getByText("Acme Systems")).toBeVisible();
  await page.getByTitle("Save to tracker").click();
  await expect(page.getByText("✓").first()).toBeVisible();

  await app.goTo(/Jobs|职位/);
  await page.getByPlaceholder("Search jobs…").fill("Acme");
  await expect(page.getByText("Acme Systems")).toBeVisible();
  await expect(page.getByText("Backend Engineer")).toBeVisible();
});
