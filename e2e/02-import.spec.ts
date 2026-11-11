import path from "node:path";
import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers";

const SAMPLE = path.resolve(__dirname, "../samples/orders-demo.csv");

test.describe.configure({ mode: "serial" });

test("administrator creates an import template from a sample file", async ({ page }) => {
  await loginAs(page, "admin");
  await page.getByRole("link", { name: "Импорт" }).click();
  await page.getByRole("link", { name: "Новый шаблон" }).click();

  await page.getByLabel("Файл-образец").setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Прочитать колонки" }).click();

  // Columns are suggested from the header names.
  await expect(page.getByLabel("Номер заказа", { exact: true })).toHaveValue("Номер заказа");
  await expect(page.getByLabel("Количество", { exact: true })).toHaveValue("Количество");

  await page.getByLabel("Название шаблона").fill("Демо");
  await page.getByRole("button", { name: "Сохранить шаблон" }).click();

  await expect(page.getByRole("heading", { name: "Импорт заказов" })).toBeVisible();
  await expect(page.getByLabel("Шаблон")).toContainText("Демо");
});

test("logistician imports a file, fixes an error row and re-uploads without duplicates", async ({ page }) => {
  await loginAs(page, "logist");
  await page.goto("/import");
  await expect(page.getByRole("link", { name: "Новый шаблон" })).toHaveCount(0);

  await page.getByLabel("Файл с заказами").setInputFiles(SAMPLE);
  await page.getByLabel("Шаблон").selectOption({ label: "Демо" });
  await page.getByRole("button", { name: "Загрузить и проверить" }).click();

  await expect(page.getByText("Готово к загрузке: 5")).toBeVisible();
  await expect(page.getByText("С ошибками: 1")).toBeVisible();
  await expect(page.getByText("Точка «SHOP-9» не найдена в справочнике")).toBeVisible();

  await page.getByRole("button", { name: "Загрузить заказы" }).click();
  await expect(page.getByTestId("count-added")).toHaveText("5");
  await expect(page.getByTestId("count-errors")).toHaveText("1");

  // Fix the unknown point in the error row and process that row alone.
  const errorRow = page.getByTestId("error-row").first();
  await errorRow.getByLabel("Точка").fill("SHOP-3");
  await errorRow.getByRole("button", { name: "Обработать строку" }).click();
  await expect(page.getByTestId("count-added")).toHaveText("6");
  await expect(page.getByTestId("count-errors")).toHaveText("0");
  await expect(page.getByTestId("error-row")).toHaveCount(0);

  // The same file again: nothing is duplicated.
  await page.goto("/import");
  await page.getByLabel("Файл с заказами").setInputFiles(SAMPLE);
  await page.getByLabel("Шаблон").selectOption({ label: "Демо" });
  await page.getByRole("button", { name: "Загрузить и проверить" }).click();
  await expect(page.getByText("Файл уже загружался")).toBeVisible();
  await page.getByRole("button", { name: "Загрузить заказы" }).click();
  await expect(page.getByTestId("count-skipped")).toHaveText("5");
  await expect(page.getByTestId("count-added")).toHaveText("0");
});

test("warehouse role has no import section", async ({ page }) => {
  await loginAs(page, "warehouse");
  await expect(page.getByRole("link", { name: "Импорт" })).toHaveCount(0);
  await page.goto("/import");
  await expect(page.getByText("Недостаточно прав")).toBeVisible();
});
