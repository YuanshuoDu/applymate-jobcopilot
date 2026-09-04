import { expect, test } from "./fixtures";

test("approval pauses the turn and resumes only after an explicit decision", async ({ harness, page }) => {
  await harness.open();
  const composer = page.getByLabel(harness.text("composer"));
  await composer.fill("Prepare an application review");
  await composer.focus();
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveAttribute("data-action", "send");
  await page.getByRole("button", { name: harness.text("send") }).click();
  await composer.focus();
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveAttribute("data-action", "stop");
  await page.getByRole("button", { name: harness.text("requestApproval") }).click();
  await expect(page.getByTestId("stream-status")).toHaveText(harness.text("waitingApproval"));
  await expect(page.getByRole("button", { name: harness.text("approve") })).toBeVisible();
  await composer.focus();
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveAttribute("data-action", "approve");
  await page.getByRole("button", { name: harness.text("approve") }).click();
  await expect(page.getByTestId("stream-status")).toHaveText(harness.text("completed"));
  await expect(page.getByText(harness.text("approved"), { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: harness.text("approve") })).toBeHidden();
});
