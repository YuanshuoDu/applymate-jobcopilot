import { expect, test } from "./fixtures";

test("final renders the completed answer after the turn closes", async ({ harness, page }) => {
  await harness.open();
  await page.getByLabel(harness.text("composer")).fill("Create my weekly job-search plan");
  await page.getByRole("button", { name: harness.text("send") }).click();
  await page.getByRole("button", { name: harness.text("complete") }).click();
  await expect(page.getByTestId("stream-status")).toHaveText(harness.text("completed"));
  await expect(page.getByText(harness.text("final"), { exact: true })).toBeVisible();
});
