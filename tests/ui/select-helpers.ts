import { expect, type Locator } from "@playwright/test";

/** Exercise the visible combobox; never bypass it by mutating its form select. */
export async function chooseOption(control: Locator, value: string) {
  control = control.filter({ visible: true });
  await control.click();
  const option = control.page().getByRole("listbox").locator(`[role="option"][data-value=${JSON.stringify(value)}]`).first();
  await expect(option).toBeVisible();
  await expect(option).not.toHaveAttribute("aria-disabled", "true");
  await option.click();
  await expect(control).toHaveAttribute("aria-expanded", "false");
}
