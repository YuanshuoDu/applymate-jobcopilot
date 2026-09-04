import { expect, test } from "./fixtures";

test("approval timeout closes the gate and does not submit", async ({ harness, page }) => {
  await harness.open();
  await page.getByRole("button", { name: harness.text("requestApproval") }).click();
  await page.getByRole("button", { name: harness.text("timeout") }).click();
  await expect(page.getByTestId("stream-status")).toHaveText(harness.text("timedOut"));
  await expect(page.getByText(harness.text("timeoutMessage"), { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: harness.text("approve") })).toBeHidden();
  await expect(page.getByRole("button", { name: harness.text("reject") })).toBeHidden();
  await expect(page.getByTestId("external-write-count")).toHaveText(harness.text("noExternalWrites"));
});
