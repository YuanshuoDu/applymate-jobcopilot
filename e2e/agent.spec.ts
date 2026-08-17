import { expect, test } from "./fixtures";

test.skip(
  !process.env.E2E_BASE_URL && !process.env.DATABASE_URL,
  "Set DATABASE_URL for the seeded demo user or E2E_BASE_URL for an already-running seeded app.",
);

test("login -> agent page -> run scout -> see results", async ({ app, page }) => {
  await app.installMocks();
  await app.login();

  await app.goTo(/Agent|agent/);
  await page.getByRole("button", { name: "Find matching jobs" }).click();
  await page.getByPlaceholder(/Message the Orchestrator/).press("Enter");

  await expect(page.getByText(/Scout found 1 result/)).toBeVisible();
  await expect(page.getByText(/Cloudflare · Systems Engineer/)).toBeVisible();
  await expect(page.getByText(/Pipeline completed/).first()).toBeVisible();
});
