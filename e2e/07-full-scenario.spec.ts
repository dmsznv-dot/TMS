import path from "node:path";
import ExcelJS from "exceljs";
import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers";

const SAMPLE = path.resolve(__dirname, "../samples/orders-demo.xlsx");

test.describe.configure({ mode: "serial" });

let tripNumber = "";
let driverUrl = "";

test("an order file becomes a planned trip with one order split between two trips", async ({ page }) => {
  await loginAs(page, "logist");

  // The sample file has one wrong row on purpose (point SHOP-9).
  await page.getByRole("link", { name: "Импорт" }).click();
  await page.getByLabel("Файл с заказами").setInputFiles(SAMPLE);
  await page.getByLabel("Шаблон").selectOption({ label: "Демо" });
  await page.getByRole("button", { name: "Загрузить и проверить" }).click();
  await expect(page.getByText("С ошибками: 1")).toBeVisible();
  await expect(page.getByText("Точка «SHOP-9» не найдена в справочнике")).toBeVisible();
  await page.getByRole("button", { name: "Загрузить заказы" }).click();
  await expect(page.getByTestId("count-errors")).toHaveText("1");
  const errorRow = page.getByTestId("error-row").first();
  await errorRow.getByLabel("Точка").fill("SHOP-5");
  await errorRow.getByRole("button", { name: "Обработать строку" }).click();
  await expect(page.getByTestId("count-errors")).toHaveText("0");

  // A trip from two orders; five of eight pallets of the first one, three stay in the queue.
  await page.getByRole("link", { name: "Планирование" }).click();
  await page.getByLabel("Точка погрузки").selectOption({ label: "Склад на Станционной" });
  await page.getByRole("button", { name: "Создать рейс" }).click();
  tripNumber = (await page.getByTestId("trip-number").innerText()).trim();
  expect(tripNumber).toMatch(/^Р-\d{4}$/);

  const first = page.getByTestId("order-З-3004");
  await first.getByLabel("Количество").fill("5");
  await first.getByRole("button", { name: "Добавить в рейс" }).click();
  await expect(first).toContainText("осталось 3");
  await page.getByTestId("order-З-3005").getByRole("button", { name: "Добавить в рейс" }).click();
  await expect(page.getByTestId("order-З-3005")).toHaveCount(0);

  // Calculate, choose an executor, save and assign.
  await page.getByLabel("Выезд со склада").fill("2026-11-13T10:00");
  await page.getByRole("button", { name: "Рассчитать маршрут" }).click();
  const rows = page.getByTestId("option-row");
  await expect(rows.first()).toBeVisible();
  await expect(rows.first()).toContainText("в окне");
  await page.getByLabel("Водитель").selectOption({ label: "Пётр Петров" });
  await page.getByLabel("Платные дороги").selectOption("none");
  await rows.first().getByRole("button", { name: "Выбрать" }).click();
  await page.getByRole("button", { name: "Сохранить план" }).click();
  await expect(page.getByTestId("trip-status")).toHaveText("Запланирован");
  await page.getByRole("button", { name: "Назначить" }).click();
  await expect(page.getByTestId("trip-status")).toHaveText("Назначен");

  // The unsplit remainder of the first order is still in the queue for another trip.
  await page.goto("/planning");
  await expect(page.getByTestId("order-З-3004")).toContainText("3");
});

test("the driver completes the trip from a link and sees no money", async ({ page, browser }) => {
  await loginAs(page, "logist");
  await page.getByRole("link", { name: "Рейсы" }).click();
  await page.getByRole("link", { name: tripNumber }).click();
  await page.getByRole("link", { name: "Исполнение" }).click();
  await page.getByRole("button", { name: "Создать ссылку для водителя" }).click();
  driverUrl = (await page.getByTestId("share-url").inputValue()).trim();

  const context = await browser.newContext({ locale: "ru-RU", timezoneId: "Asia/Novosibirsk" });
  const driver = await context.newPage();
  await driver.goto(driverUrl);
  expect(await driver.locator("body").innerText()).not.toContain("₽");
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

  await page.reload();
  await expect(page.getByTestId("trip-status-badge")).toContainText("Выполнен");
});

test("the warehouse accepts the goods with a shortage", async ({ page }) => {
  await loginAs(page, "warehouse");
  await page.getByRole("link", { name: "Рейсы" }).click();
  await page.getByRole("link", { name: tripNumber }).click();
  await page.getByRole("link", { name: "Приёмка" }).click();
  const row = page.getByTestId("acceptance-row-З-3004");
  await row.getByLabel("Принято").fill("3");
  await row.getByLabel("Причина").selectOption("shortage");
  await row.getByLabel("Подтверждение").fill("Акт № 20");
  await row.getByRole("button", { name: "Сохранить приёмку" }).click();
  await expect(row).toContainText("принято 3");
  await expect(page.getByTestId("task-list")).toContainText("Недопоставка по заказу З-3004: принято 3 из 5");
});

test("finance enters money, records a partial payment and closes the trip with a reason", async ({ page }) => {
  await loginAs(page, "finance");
  await page.getByRole("link", { name: "Рейсы" }).click();
  await page.getByRole("link", { name: tripNumber }).click();
  await page.getByRole("link", { name: "Деньги" }).click();

  await page.getByLabel("Вид начисления").selectOption("revenue");
  await page.getByLabel("Описание начисления").fill("Доставка по договору");
  await page.getByLabel("Сумма начисления, ₽").fill("60000");
  await page.getByRole("button", { name: "Добавить начисление" }).click();
  await expect(page.getByTestId("accrual-list")).toContainText("60 000,00 ₽");

  await page.getByLabel("Статья расхода").selectOption("fuel");
  await page.getByLabel("Сумма расхода, ₽").fill("2100");
  await page.getByRole("button", { name: "Добавить расход" }).click();
  await expect(page.getByTestId("expense-list")).toContainText("2 100,00 ₽");

  await page.getByLabel("Контрагент счёта").selectOption({ label: "Сеть «Продукты у дома»" });
  await page.getByLabel("Номер счёта").fill("25");
  await page.getByLabel("Срок оплаты").fill("2026-11-30");
  await page.getByLabel("Сумма счёта, ₽").fill("60000");
  await page.getByRole("button", { name: "Создать счёт" }).click();
  await expect(page.getByTestId("invoice-list")).toContainText("60 000,00 ₽");

  await page.getByRole("link", { name: "Счета и оплаты" }).click();
  await page.getByLabel("Направление платежа").selectOption("in");
  await page.getByLabel("Контрагент платежа").selectOption({ label: "Сеть «Продукты у дома»" });
  await page.getByLabel("Сумма платежа, ₽").fill("30000");
  await page.getByLabel("Назначение платежа").fill("Оплата по счёту 25, часть");
  await page.getByRole("button", { name: "Внести платёж" }).click();
  const payment = page.getByTestId("payment-card").first();
  await expect(payment).toContainText("Ждёт разнесения");
  await payment.getByLabel("Счёт для разнесения").selectOption({ index: 1 });
  await payment.getByRole("button", { name: "Разнести" }).click();
  await expect(page.getByTestId("payment-card").first()).toContainText("Разнесён полностью");

  await page.getByRole("link", { name: "Рейсы" }).click();
  await page.getByRole("link", { name: tripNumber }).click();
  await page.getByRole("link", { name: "Деньги" }).click();
  await expect(page.getByTestId("debt-receivable")).toContainText("30 000,00 ₽");

  // The second order has no acceptance, so closing needs a reason.
  await page.getByRole("button", { name: "Закрыть рейс" }).click();
  await expect(page.getByTestId("form-error")).toContainText("Данные рейса неполны");
  await page.getByLabel("Причина закрытия").fill("Приёмку по второму заказу внесём позже");
  await page.getByRole("button", { name: "Закрыть рейс" }).click();
  await expect(page.getByTestId("trip-status-badge")).toContainText("Финансово закрыт");
});

test("the plan-vs-actual export holds the trip and the triage queue shows the shortage", async ({ page }) => {
  await loginAs(page, "finance");
  await page.getByRole("link", { name: "Выгрузки" }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("heading", { name: "План и факт по рейсам" })
      .locator("xpath=ancestor::div[contains(@class,'space-y-3')][1]")
      .getByRole("link", { name: "XLSX" })
      .click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^plan_fact-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile((await download.path())!);
  const text: string[] = [];
  workbook.worksheets[0].eachRow((r) => text.push(JSON.stringify(r.values)));
  expect(text.join("\n")).toContain(tripNumber);

  await page.getByRole("link", { name: "Разобрать" }).click();
  await expect(page.getByTestId("triage-partial_acceptance")).toContainText("З-3004");
});
