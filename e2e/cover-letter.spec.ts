import { expect, test } from "./fixtures";

test.skip(
  !process.env.E2E_BASE_URL && !process.env.DATABASE_URL,
  "Set DATABASE_URL for the seeded demo user or E2E_BASE_URL for an already-running seeded app.",
);

test("login -> saved job -> score -> generate cover letter", async ({ app, page }) => {
  await app.installMocks();
  await app.login();

  await app.goTo(/Jobs|职位/);
  await page.getByText("Cloudflare").first().click();
  await page.getByRole("button", { name: /Score|Re-score/ }).click();
  await expect(page.getByText("91/100")).toBeVisible();

  await page.getByRole("button", { name: "✕" }).first().click();
  await page.getByRole("button", { name: /\+ Basket/ }).click();
  await page.getByRole("button", { name: /Basket 1/ }).click();
  await page.getByRole("button", { name: /Tailor CVs/ }).click();

  await expect(page.getByText(/Cover letters ready/)).toBeVisible();
  expect(app.jobs[0].coverLetter).toContain("Dear Hiring Team");
});
