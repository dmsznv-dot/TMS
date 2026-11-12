import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers";

test("logistician plans a trip with a split order, assigns it and re-plans it", async ({ page }) => {
  await loginAs(page, "logist");

  // A new trip from the warehouse.
  await page.getByLabel("Точка погрузки").selectOption({ label: "Склад на Станционной" });
  await page.getByRole("button", { name: "Создать рейс" }).click();
  await expect(page.getByTestId("trip-number")).toHaveText(/Р-\d{4}/);
  await expect(page.getByTestId("trip-status")).toHaveText("Черновик");

  // Six of ten pallets of the first order; four stay in the queue.
  const first = page.getByTestId("order-П-2001");
  await first.getByLabel("Количество").fill("6");
  await first.getByRole("button", { name: "Добавить в рейс" }).click();
  await expect(first).toContainText("осталось 4");

  // The whole second order.
  await page.getByTestId("order-П-2002").getByRole("button", { name: "Добавить в рейс" }).click();
  await expect(page.getByTestId("order-П-2002")).toHaveCount(0);
  const stops = page.getByTestId("stop-list");
  await expect(stops).toContainText("Магазин на Красном проспекте");
  await expect(stops).toContainText("Магазин на Затулинке");

  // Calculate: two variants, marked as the built-in demo calculation.
  await page.getByRole("button", { name: "Рассчитать маршрут" }).click();
  await expect(page.getByTestId("quota-badge")).toContainText("Демо-расчёт, не 2ГИС");
  const rows = page.getByTestId("option-row");
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThanOrEqual(2);
  await expect(rows.first()).toContainText("А777АА154");
  await expect(rows.first()).toContainText("в окне");

  // Choose an executor and save the plan.
  await page.getByLabel("Водитель").selectOption({ label: "Пётр Петров" });
  await page.getByLabel("Платные дороги").selectOption("none");
  await rows.first().getByRole("button", { name: "Выбрать" }).click();
  await page.getByRole("button", { name: "Сохранить план" }).click();
  await expect(page.getByTestId("trip-status")).toHaveText("Запланирован");

  await page.getByRole("button", { name: "Назначить" }).click();
  await expect(page.getByTestId("trip-status")).toHaveText("Назначен");

  // Re-plan: a reason is required, and both versions are kept.
  await page.getByRole("button", { name: "Рассчитать маршрут" }).click();
  await expect(rows.first()).toBeVisible();
  await page.getByLabel("Водитель").selectOption({ label: "Пётр Петров" });
  await page.getByLabel("Платные дороги").selectOption("none");
  await rows.first().getByRole("button", { name: "Выбрать" }).click();
  await page.getByRole("button", { name: "Сохранить план" }).click();
  await expect(page.getByTestId("form-error")).toContainText("причину");
  await page.getByLabel("Причина изменения плана").fill("Сдвиг окна");
  await page.getByRole("button", { name: "Сохранить план" }).click();
  await expect(page.getByTestId("plan-saved")).toContainText("версия 2");

  await page.getByRole("link", { name: "Открыть карточку рейса" }).click();
  await expect(page.getByRole("heading", { name: /Рейс Р-\d{4}/ })).toBeVisible();
  await expect(page.getByTestId("plan-version")).toHaveCount(2);
  await expect(page.getByTestId("plan-version").first()).toContainText("Сдвиг окна");
  await expect(page.getByTestId("plan-current")).toContainText("Пётр Петров");
  await expect(page.getByTestId("plan-current")).toContainText("демо-расчёт, не 2ГИС");

  // The remaining four pallets go on a second trip.
  await page.goto("/planning");
  await page.getByLabel("Точка погрузки").selectOption({ label: "Склад на Станционной" });
  await page.getByRole("button", { name: "Создать рейс" }).click();
  const rest = page.getByTestId("order-П-2001");
  await expect(rest.getByLabel("Количество")).toHaveValue("4");
  await rest.getByRole("button", { name: "Добавить в рейс" }).click();
  await expect(page.getByTestId("order-П-2001")).toHaveCount(0);

  // The only truck is already busy on the first trip at the same time: the screen says so
  // instead of staying silent.
  await page.getByRole("button", { name: "Рассчитать маршрут" }).click();
  await expect(page.getByTestId("no-executors")).toBeVisible();
  await expect(page.getByText("А777АА154 не предлагается: Занята на другом рейсе")).toBeVisible();
});

test("a trip list shows the trips with their status", async ({ page }) => {
  await loginAs(page, "logist");
  await page.getByRole("link", { name: "Рейсы" }).click();
  await expect(page.getByRole("heading", { name: "Рейсы" })).toBeVisible();
  await expect(page.getByRole("row", { name: /Назначен/ }).first()).toBeVisible();
  await expect(page.getByRole("row", { name: /Черновик/ }).first()).toBeVisible();
  await page.getByRole("link", { name: "Черновик" }).click();
  await expect(page).toHaveURL(/status=draft/);
  await expect(page.getByRole("row", { name: /Назначен/ })).toHaveCount(0);
});

test("warehouse sees the planning screen without planning controls", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Почта").fill("warehouse@demo.local");
  await page.getByLabel("Пароль").fill("demo12345");
  await page.getByRole("button", { name: "Войти" }).click();
  await page.goto("/planning");
  await expect(page.getByRole("button", { name: "Создать рейс" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Рассчитать маршрут" })).toHaveCount(0);
});
