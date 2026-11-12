import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers";

test.describe.configure({ mode: "serial" });

test("finance works the money of a trip, sees the debt apart from the result and closes with a reason", async ({ page }) => {
  await loginAs(page, "finance");
  await page.getByRole("link", { name: "Рейсы" }).click();
  await page.getByRole("link", { name: "Р-0002" }).click();
  await page.getByRole("link", { name: "Деньги" }).click();

  // Revenue.
  await page.getByLabel("Вид начисления").selectOption("revenue");
  await page.getByLabel("Описание начисления").fill("Доставка по договору");
  await page.getByLabel("Сумма начисления, ₽").fill("112000");
  await page.getByRole("button", { name: "Добавить начисление" }).click();
  await expect(page.getByTestId("accrual-list")).toContainText("112 000,00 ₽");

  // Actual expenses; the unplanned toll is marked as not incurred.
  await page.getByLabel("Статья расхода").selectOption("fuel");
  await page.getByLabel("Сумма расхода, ₽").fill("3450");
  await page.getByRole("button", { name: "Добавить расход" }).click();
  await expect(page.getByTestId("expense-list")).toContainText("3 450,00 ₽");
  await page.getByLabel("Статья расхода").selectOption("driver");
  await page.getByLabel("Сумма расхода, ₽").fill("1800");
  await page.getByRole("button", { name: "Добавить расход" }).click();
  await expect(page.getByTestId("expense-list")).toContainText("1 800,00 ₽");
  await page.getByRole("button", { name: "Не было: Платные дороги" }).click();
  await expect(page.getByTestId("expense-list")).toContainText("не было");

  while ((await page.getByRole("button", { name: "Проверить" }).count()) > 0) {
    await page.getByRole("button", { name: "Проверить" }).first().click();
    await page.waitForTimeout(300);
  }

  const marginBefore = await page.getByTestId("fact-margin").innerText();
  expect(marginBefore).toMatch(/\d/);
  await expect(page.getByTestId("debt-receivable")).toContainText("0,00 ₽");

  // An invoice for the whole revenue.
  await page.getByLabel("Контрагент счёта").selectOption({ label: "ООО Ромашка" });
  await page.getByLabel("Номер счёта").fill("15");
  await page.getByLabel("Срок оплаты").fill("2026-11-30");
  await page.getByLabel("Сумма счёта, ₽").fill("112000");
  await page.getByRole("button", { name: "Создать счёт" }).click();
  await expect(page.getByTestId("invoice-list")).toContainText("112 000,00 ₽");
  await expect(page.getByTestId("debt-receivable")).toContainText("112 000,00 ₽");

  // A payment of 80 000 ₽ on the payments screen, allocated by hand.
  await page.getByRole("link", { name: "Счета и оплаты" }).click();
  await page.getByLabel("Направление платежа").selectOption("in");
  await page.getByLabel("Контрагент платежа").selectOption({ label: "ООО Ромашка" });
  await page.getByLabel("Сумма платежа, ₽").fill("80000");
  await page.getByLabel("Назначение платежа").fill("Оплата по счёту 15");
  await page.getByRole("button", { name: "Внести платёж" }).click();
  const payment = page.getByTestId("payment-card").first();
  await expect(payment).toContainText("Ждёт разнесения");
  await payment.getByLabel("Счёт для разнесения").selectOption({ index: 1 });
  await payment.getByRole("button", { name: "Разнести" }).click();
  await expect(page.getByTestId("payment-card").first()).toContainText("Разнесён полностью");

  // Back on the trip: the debt fell, the result did not.
  await page.getByRole("link", { name: "Рейсы" }).click();
  await page.getByRole("link", { name: "Р-0002" }).click();
  await page.getByRole("link", { name: "Деньги" }).click();
  await expect(page.getByTestId("debt-receivable")).toContainText("32 000,00 ₽");
  await expect(page.getByTestId("fact-margin")).toHaveText(marginBefore);

  // Closing with missing data needs a reason.
  await expect(page.getByTestId("completeness")).toContainText("нет приёмки");
  await page.getByRole("button", { name: "Закрыть рейс" }).click();
  await expect(page.getByTestId("form-error")).toContainText("Данные рейса неполны");
  await page.getByLabel("Причина закрытия").fill("Приёмку по второму заказу сверим позже");
  await page.getByRole("button", { name: "Закрыть рейс" }).click();
  await expect(page.getByTestId("trip-status-badge")).toContainText("Финансово закрыт");

  // The reason is in the history.
  await page.getByRole("link", { name: "История" }).click();
  await expect(page.getByTestId("history-list")).toContainText("Закрыт с исключением");
  await expect(page.getByTestId("history-list")).toContainText("Приёмку по второму заказу сверим позже");
  await expect(page.getByTestId("history-list")).toContainText("Оплата разнесена: 80 000,00 ₽");
});

test("documents are entered by hand and keep a log", async ({ page }) => {
  await loginAs(page, "logist");
  await page.getByRole("link", { name: "Рейсы" }).click();
  await page.getByRole("link", { name: "Р-0002" }).click();
  await page.getByRole("link", { name: "Документы" }).click();

  await page.getByLabel("Вид документа").fill("ЭПД");
  await page.getByLabel("Номер документа").fill("ЭН-1");
  await page.getByLabel("Ссылка или идентификатор у оператора").fill("diadoc:abc123");
  await page.getByRole("button", { name: "Добавить документ" }).click();
  const doc = page.getByTestId("document-card").first();
  await expect(doc).toContainText("ЭН-1");
  await expect(doc).toContainText("diadoc:abc123");

  await doc.getByLabel("Статус документа").selectOption("signed");
  await expect(doc).toContainText("Подписан");
  await expect(doc.getByTestId("document-log")).toContainText("Черновик");
});

test("the warehouse role has no money tab and no payments screen", async ({ page }) => {
  await loginAs(page, "warehouse");
  await page.getByRole("link", { name: "Рейсы" }).click();
  await page.getByRole("link", { name: "Р-0002" }).click();
  await expect(page.getByRole("link", { name: "Деньги" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "История" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Счета и оплаты" })).toHaveCount(0);
  await page.goto("/money");
  await expect(page.getByText("Недостаточно прав")).toBeVisible();
});
