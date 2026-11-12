import { expect, type Page } from "@playwright/test";
import type { Role } from "@/domain/permissions";

export const DEMO_PASSWORD = "demo12345";

/** Signs in as the demo user of the given role. */
export async function loginAs(page: Page, role: Role): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Почта").fill(`${role}@demo.local`);
  await page.getByLabel("Пароль").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Планирование" })).toBeVisible();
}

/** The error message shown by a form (Next.js adds its own alert element for route changes). */
export function formError(page: Page) {
  return page.locator("[data-form-error]");
}
