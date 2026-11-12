import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers";

test("administrator changes the calculation rules and adds a user", async ({ page }) => {
  await loginAs(page, "admin");
  await page.getByRole("link", { name: "Настройки" }).click();
  await expect(page.getByRole("heading", { name: "Настройки" })).toBeVisible();

  await page.getByLabel("Запас по окну, мин").fill("30");
  await page.getByLabel("Цена топлива, ₽ за литр").fill("72,50");
  await page.getByRole("button", { name: "Сохранить настройки" }).click();
  await expect(page.getByTestId("settings-saved")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Запас по окну, мин")).toHaveValue("30");
  await expect(page.getByLabel("Цена топлива, ₽ за литр")).toHaveValue("72,50");
  await page.getByLabel("Запас по окну, мин").fill("15");
  await page.getByLabel("Цена топлива, ₽ за литр").fill("70,00");
  await page.getByRole("button", { name: "Сохранить настройки" }).click();
  await expect(page.getByTestId("settings-saved")).toBeVisible();

  await page.getByLabel("Почта пользователя").fill("new.logist@demo.local");
  await page.getByLabel("Имя пользователя").fill("Новый логист");
  await page.getByLabel("Пароль пользователя").fill("short");
  await page.getByRole("button", { name: "Добавить пользователя" }).click();
  await expect(page.getByTestId("form-error").last()).toBeVisible();
  await page.getByLabel("Пароль пользователя").fill("long-enough-1");
  await page.getByRole("button", { name: "Добавить пользователя" }).click();
  await expect(page.getByTestId("user-list")).toContainText("new.logist@demo.local");

  await page.getByRole("row", { name: /new.logist@demo.local/ }).getByRole("button", { name: "Отключить" }).click();
  await expect(page.getByRole("row", { name: /new.logist@demo.local/ })).toContainText("отключён");
});

test("only the administrator sees the settings", async ({ page }) => {
  await loginAs(page, "logist");
  await expect(page.getByRole("link", { name: "Настройки" })).toHaveCount(0);
  await page.goto("/settings");
  await expect(page.getByText("Недостаточно прав")).toBeVisible();
});
