import { expect, test } from "@playwright/test";
import { formError, loginAs } from "./helpers";

test("wrong password is rejected with a message", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Почта").fill("logist@demo.local");
  await page.getByLabel("Пароль").fill("not-the-password");
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByText("Неверная почта или пароль")).toBeVisible();
});

test("pages require a session", async ({ page }) => {
  await page.goto("/refs/locations");
  await expect(page).toHaveURL(/\/login$/);
});

test("logistician signs in and creates a location", async ({ page }) => {
  await loginAs(page, "logist");

  await page.getByRole("link", { name: "Справочники" }).click();
  await expect(page.getByRole("heading", { name: "Точки" })).toBeVisible();

  await page.getByRole("button", { name: "Добавить" }).click();
  await page.getByLabel("Название").fill("Склад Северный");
  await page.getByLabel("Широта", { exact: true }).fill("55.0302");
  await page.getByLabel("Долгота", { exact: true }).fill("82.9204");
  await page.getByLabel("Часовой пояс").fill("Asia/Novosibirsk");
  await page.getByLabel("Тип", { exact: true }).selectOption("warehouse");
  await page.getByRole("button", { name: "Сохранить" }).click();

  const row = page.getByRole("row", { name: /Склад Северный/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText("55.0302");
});

test("invalid coordinates show a validation message", async ({ page }) => {
  await loginAs(page, "logist");
  await page.goto("/refs/locations");
  await page.getByRole("button", { name: "Добавить" }).click();
  await page.getByLabel("Название").fill("Плохая точка");
  await page.getByLabel("Широта", { exact: true }).fill("95");
  await page.getByLabel("Долгота", { exact: true }).fill("82.9");
  await page.getByLabel("Часовой пояс").fill("Asia/Novosibirsk");
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(formError(page)).toContainText("Широта");
  await expect(page.getByRole("row", { name: /Плохая точка/ })).toHaveCount(0);
});

test("warehouse role sees reference data without the add button", async ({ page }) => {
  await loginAs(page, "warehouse");
  await page.goto("/refs/locations");
  await expect(page.getByRole("heading", { name: "Точки" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Добавить" })).toHaveCount(0);
});

test("signing out ends the session", async ({ page }) => {
  await loginAs(page, "logist");
  await page.getByRole("button", { name: "Выйти" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/planning");
  await expect(page).toHaveURL(/\/login$/);
});
