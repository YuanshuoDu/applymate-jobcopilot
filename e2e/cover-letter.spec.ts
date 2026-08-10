import { expect, test } from "./fixtures";

test.skip(
  !process.env.E2E_BASE_URL && !process.env.DATABASE_URL,
  "Set DATABASE_URL for the seeded demo user or E2E_BASE_URL for an already-running seeded app.",
);

test("login -> saved job -> score -> generate cover letter", async ({ app, page }) => {
  await app.installMocks();
  await app.login();

  await app.goTo(/^(My Jobs|我的职位)(?: \d+)?$/);
  await page.getByRole("button", { name: /^Score$/ }).click();
  await expect(page.getByText("91%", { exact: true })).toBeVisible();
  await page.getByText("Cloudflare").first().click();
  await page.getByRole("button", { name: /Prepare full application pack automatically/ }).click();

  await expect(page.getByText("Generated for this job")).toBeVisible();
  expect(app.jobs[0].coverLetter).toContain("Dear Hiring Team");
});
