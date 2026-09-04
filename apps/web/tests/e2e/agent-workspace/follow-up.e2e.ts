import { expect, test } from "./fixtures";

test("follow-up keeps the same session timeline across turns", async ({ harness, page }) => {
  await harness.open();
  const composer = page.getByLabel(harness.text("composer"));
  await composer.fill("Find backend roles in Berlin");
  await page.getByRole("button", { name: harness.text("send") }).click();
  await page.getByRole("button", { name: harness.text("complete") }).click();
  await composer.fill("Filter the results to roles with relocation support");
  await page.getByRole("button", { name: harness.text("send") }).click();
  await expect(page.getByTestId("turn-count")).toHaveText("turns: 2");
  await expect(page.locator('[data-speaker="user"]')).toHaveCount(2);
  await expect(page.getByText("Filter the results to roles with relocation support", { exact: true })).toBeVisible();
});
