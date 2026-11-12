import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers";

test.describe.configure({ mode: "serial" });

let driverUrl = "";

test("logistician hands the trip to a driver and the driver completes it from the link", async ({ page, browser }) => {
  await loginAs(page, "logist");
  await page.getByRole("link", { name: "Рейсы" }).click();
  // The seeded, already assigned trip is the first one created.
  await page.getByRole("link", { name: "Р-0001" }).click();
  await page.getByRole("link", { name: "Исполнение" }).click();

  await page.getByRole("button", { name: "Создать ссылку для водителя" }).click();
  const url = page.getByTestId("share-url");
  await expect(url).toBeVisible();
  driverUrl = (await url.inputValue()).trim();
  expect(driverUrl).toMatch(/\/d\/[A-Za-z0-9_-]{40,}$/);

  // The driver opens the link without signing in.
  const context = await browser.newContext({ locale: "ru-RU", timezoneId: "Asia/Novosibirsk" });
  const driver = await context.newPage();
  await driver.goto(driverUrl);
  await expect(driver.getByRole("heading", { name: /Рейс Р-\d{4}/ })).toBeVisible();
  await expect(driver.getByTestId("driver-stop-1")).toContainText("Склад на Станционной");
  await expect(driver.getByTestId("driver-stop-2")).toContainText("Магазин в Академгородке");
  await expect(driver.getByTestId("driver-stop-3")).toContainText("Магазин на Затулинке");
  expect(await driver.locator("body").innerText()).not.toContain("₽");
  await expect(driver.getByRole("link", { name: "Открыть в Яндекс Навигаторе" })).toHaveAttribute("href", /^yandexnavi:\/\/build_route_on_map\?/);

  await driver.getByRole("button", { name: "Подтвердить назначение" }).click();
  await expect(driver.getByText("Назначение подтверждено")).toBeVisible();
  await driver.getByTestId("driver-stop-1").getByRole("button", { name: "Погружен, выезжаю" }).click();
  for (const n of [2, 3]) {
    const stop = driver.getByTestId(`driver-stop-${n}`);
    await stop.getByRole("button", { name: "Прибыл" }).click();
    await stop.getByRole("button", { name: "Разгружен" }).click();
    await expect(stop).toContainText("Разгружен");
  }
  await expect(driver.getByText("Рейс завершён или не принимает отметок")).toBeVisible();
  await context.close();

  // The logistician sees the result on the trip card.
  await page.reload();
  await expect(page.getByTestId("trip-status-badge")).toContainText("Выполнен");
  await expect(page.getByTestId("event-feed")).toContainText("Водитель подтвердил назначение");
  await expect(page.getByTestId("event-feed")).toContainText("Водитель по ссылке");
});

test("warehouse enters acceptance with a shortage and a task appears", async ({ page }) => {
  await loginAs(page, "warehouse");
  await page.getByRole("link", { name: "Рейсы" }).click();
  await page.getByRole("link", { name: "Р-0001" }).click();
  await page.getByRole("link", { name: "Приёмка" }).click();

  const row = page.getByTestId("acceptance-row-П-4001");
  await row.getByLabel("Принято").fill("3");
  await row.getByRole("button", { name: "Сохранить приёмку" }).click();
  await expect(page.getByTestId("form-error")).toContainText("причину");

  await row.getByLabel("Причина").selectOption("shortage");
  await row.getByLabel("Подтверждение").fill("Акт № 15");
  await row.getByRole("button", { name: "Сохранить приёмку" }).click();

  await expect(row).toContainText("версия 1");
  await expect(row).toContainText("принято 3");
  await expect(page.getByTestId("task-list")).toContainText("Недопоставка по заказу П-4001: принято 3 из 5");

  // A correction is a new version; the earlier one stays in the history and its task is closed.
  await row.getByLabel("Принято").fill("5");
  await row.getByRole("button", { name: "Сохранить приёмку" }).click();
  await expect(row).toContainText("версия 2");
  await page.getByText("История версий").click();
  await expect(page.getByTestId("acceptance-history")).toContainText("версия 1");
  await expect(page.getByTestId("task-list")).toContainText("Заменена новой версией приёмки");
});

test("the link stops working once it is revoked", async ({ page, browser }) => {
  await loginAs(page, "logist");
  await page.getByRole("link", { name: "Рейсы" }).click();
  await page.getByRole("link", { name: "Р-0001" }).click();
  await page.getByRole("link", { name: "Исполнение" }).click();
  await page.getByRole("button", { name: "Отозвать" }).first().click();
  await expect(page.getByText("отозвана")).toBeVisible();

  const context = await browser.newContext();
  const driver = await context.newPage();
  const response = await driver.goto(driverUrl);
  expect(response?.status()).toBe(404);
  await expect(driver.getByRole("heading", { name: "Ссылка недействительна" })).toBeVisible();
  await expect(driver.getByText("Склад на Станционной")).toHaveCount(0);
  await context.close();
});

test("a stranger's link is never accepted", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const response = await page.goto("/d/this-is-not-a-real-token");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Ссылка недействительна" })).toBeVisible();
  await context.close();
});
