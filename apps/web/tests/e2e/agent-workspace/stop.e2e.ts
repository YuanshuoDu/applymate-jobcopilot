import { expect, test } from "./fixtures";

test("Stop interrupts a running turn and remains fail-closed", async ({ harness, page }) => {
  await harness.open();
  await page.getByLabel(harness.text("composer")).fill("Prepare an application review");
  await page.getByRole("button", { name: harness.text("send") }).click();
  await page.getByRole("button", { name: harness.text("stop") }).click();
  await expect(page.getByTestId("stream-status")).toHaveText(harness.text("stopped"));
  await expect(page.getByRole("button", { name: harness.text("stop") })).toBeHidden();
  await expect(page.getByText(harness.text("stopMessage"), { exact: true })).toBeVisible();
  await expect(page.getByTestId("external-write-count")).toHaveText(harness.text("noExternalWrites"));
});
