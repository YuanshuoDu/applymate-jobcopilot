import { expect, test } from "./fixtures";

test.skip(
  !process.env.E2E_BASE_URL && !process.env.DATABASE_URL,
  "Set DATABASE_URL for the seeded demo user or E2E_BASE_URL for an already-running seeded app.",
);

test("login -> agent page -> run scout -> see results", async ({ app, page }) => {
  await app.installMocks();
  await app.login();

  await app.goTo(/Agent|智能体/);
  await page.getByRole("button", { name: /开始运行|Start Run/ }).click();

  await expect(page.getByText(/Scout found 1 result/)).toBeVisible();
  await expect(page.getByText(/Cloudflare · Systems Engineer/)).toBeVisible();
  await expect(page.getByText(/流水线完成|Pipeline complete/)).toBeVisible();
});
