# Прототип «Поставки и экономика рейсов» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Веб-сервис, в котором сценарий «заказ из файла → рейс → маршрут и исполнитель → исполнение → приёмка → деньги → финансовое закрытие» проходит целиком на демо-данных.

**Architecture:** Один сервис Next.js. Расчёты лежат в `src/domain` без ввода-вывода и покрыты модульными тестами. Сценарии лежат в `src/server/services`, принимают контекст организации и проверяются интеграционными тестами на PostgreSQL. Страницы вызывают только сервисы.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, PostgreSQL 16, Drizzle ORM, zod 4, Tailwind CSS 4, Leaflet, exceljs, csv-parse, csv-stringify, date-fns и @date-fns/tz, Vitest, Playwright 1.63.0.

**Spec:** `docs/superpowers/specs/2026-11-11-tms-prototype-design.md`

## Global Constraints

- Деньги — целые копейки (`number`). Количества — целые тысячные доли единицы (`QtyMilli`). Дробных чисел в деньгах и количествах нет.
- Ставка НДС хранится в базисных пунктах: 22 % = `2200`. Расчёты ведутся на базе без НДС.
- Время хранится в UTC (`timestamptz`). Пояс точки используется только при разборе файла и показе.
- `src/domain` не импортирует `src/server`, `src/app`, `pg`, `drizzle-orm`, `next`.
- Каждый сервис имеет вид `(ctx: Ctx, input) => Promise<…>`. Идентификатор организации из запроса клиента не принимается.
- Каждая таблица с данными клиента имеет `org_id`; каждый запрос фильтруется по `ctx.orgId`.
- Ключ 2ГИС читается только на сервере из `TWOGIS_API_KEY`. В клиентский код, журналы и выгрузки он не попадает.
- Сырой ответ 2ГИС и геометрия в базу и в файлы репозитория не записываются. Тестовые ответы 2ГИС пишутся вручную по форме из документации.
- Живой запрос в 2ГИС уходит только из `calculateRoutes` по действию пользователя. В тестах и по умолчанию `ROUTING_MODE=synthetic`.
- Рядом со значениями из 2ГИС стоит ссылка «2ГИС» на `http://dev.2gis.ru`.
- Язык интерфейса — русский. Идентификаторы в коде — английские.
- Версия `@playwright/test` закреплена на `1.63.0` (совпадает с установленным браузером).
- Версия TypeScript — та, что ставит `create-next-app`; вручную до 7.x не поднимать.
- Перед использованием API Next.js 16 сверяться с документацией установленной версии: `cookies()`, `params` и `searchParams` асинхронные.
- Разработка через тесты: сначала падающий тест, затем код.
- Коммит после каждой задачи в ветку `claude/intelligent-lovelace-lzkbvh`. Сообщение заканчивается строками:
  ```
  Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JCFtoHWxZuvWxd1mwAhLD2
  ```

## Review Focus

Спецификация не описывает эти случаи, но пользователь с ними столкнётся. Тест на каждый добавлен в задачу-владельца.

1. **CSV из 1С в кодировке Windows-1251, числа вида `1 234,5`, даты ячейками Excel.** Ожидание: файл читается, числа и даты разбираются, либо строка получает понятную ошибку. → Задача 8.
2. **Два логиста одновременно распределяют одну строку заказа по разным рейсам.** Ожидание: сумма распределений не превышает количество; второй запрос получает ошибку. → Задача 11.
3. **Ссылка водителя на отменённый рейс, просроченная или отозванная.** Ожидание: страница «ссылка недействительна» без данных рейса; отметки не принимаются. → Задача 16.
4. **2ГИС отвечает HTML, пустым телом или JSON другой формы.** Ожидание: причина `unavailable`, приложение не падает, единица лимита не списывается. → Задача 13.
5. **Машину деактивируют или точке меняют координаты после сохранения плана.** Ожидание: сохранённая версия плана не меняется; деактивированная машина не предлагается в новых планах. → Задача 14.

## Структура файлов

```
drizzle/                       миграции
scripts/dev-db.sh              локальный PostgreSQL: роль и базы
scripts/migrate.ts             применение миграций
scripts/seed.ts                демо-данные и файлы samples/
src/domain/
  errors.ts money.ts qty.ts time.ts permissions.ts
  orderStatus.ts allocation.ts tripStatus.ts
  geo.ts eta.ts costEstimate.ts comparison.ts
  economics.ts reconciliation.ts completeness.ts
  importMapping.ts yandexLinks.ts
src/server/
  env.ts
  db/client.ts db/schema/{org,refs,orders,trips,money,import,misc}.ts db/schema/index.ts
  auth/{password,session,context,rateLimit}.ts
  routing/{types,synthetic,twogis,wkt,quota,variantToken,index}.ts
  import/{parse,jobs,worker}.ts
  export/{datasets,writers}.ts
  services/{audit,users,refs,orders,trips,planning,offers,shareLinks,
            execution,acceptance,tasks,finance,economics,close,triage}.ts
src/app/
  login/ (app)/{planning,trips,trips/[id],triage,import,refs,money,settings}/
  d/[token]/ api/export/
src/components/                общие компоненты, карта
tests/helpers/{testDb,factories}.ts
tests/integration/*.test.ts
e2e/*.spec.ts
samples/                       файлы для импорта
```

---

## Фаза A. Основа

### Task 1: Каркас проекта и тестовая база

**Files:**
- Create: проект Next.js в корне; `vitest.config.ts`, `playwright.config.ts`, `drizzle.config.ts`, `scripts/dev-db.sh`, `scripts/migrate.ts`, `src/server/env.ts`, `src/server/db/client.ts`, `tests/helpers/testDb.ts`, `tests/integration/smoke.test.ts`, `src/domain/errors.ts`, `.env.example`

**Interfaces:**
- Produces:
  - `npm test` — модульные тесты `src/domain/**/*.test.ts`; `npm run test:int` — `tests/integration/**/*.test.ts`; `npm run e2e` — Playwright; `npm run db:generate`, `npm run db:migrate`.
  - `src/server/db/client.ts`: `type Db = NodePgDatabase<typeof schema>`; `getDb(): Db` (по `DATABASE_URL`).
  - `tests/helpers/testDb.ts`: `withTestDb(): Promise<{ db: Db; close(): Promise<void> }>` — создаёт схему `t_<random>` в базе `TEST_DATABASE_URL`, задаёт `search_path`, применяет миграции с `migrationsSchema` равной этой схеме, при `close()` удаляет схему.
  - `src/domain/errors.ts`: `class DomainError extends Error { constructor(public code: string, message: string) }`.
  - `src/server/env.ts`: `env` — объект, разобранный zod из `process.env`, с полями из раздела 16 спецификации и значениями по умолчанию `ROUTING_MODE=synthetic`, `TWOGIS_REQUEST_LIMIT=1000`, `ROUTE_METRICS_STORAGE=plan`, `EXPORT_PROVIDER_METRICS=false`, `MAP_TILE_URL=https://tile.openstreetmap.org/{z}/{x}/{y}.png`.

- [ ] **Step 1:** Создать проект: `npx create-next-app@16 . --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --yes`. Каталог `docs/` сохранить.
- [ ] **Step 2:** Установить зависимости: `drizzle-orm pg zod exceljs csv-parse csv-stringify leaflet react-leaflet date-fns @date-fns/tz`; для разработки: `drizzle-kit vitest @types/pg @types/leaflet tsx @playwright/test@1.63.0`.
- [ ] **Step 3:** `scripts/dev-db.sh`: запускает `service postgresql start`, создаёт роль `tms` с паролем `tms` и базы `tms_dev`, `tms_test`, `tms_e2e`; повторный запуск не падает.
- [ ] **Step 4:** Написать падающий тест `tests/integration/smoke.test.ts`:

```ts
it("connects to an isolated schema", async () => {
  const t = await withTestDb();
  const r = await t.db.execute(sql`select current_schema() as s`);
  expect(String(r.rows[0].s)).toMatch(/^t_/);
  await t.close();
});
```

- [ ] **Step 5:** Запустить `bash scripts/dev-db.sh && npm run test:int` — тест падает: `withTestDb` не определён.
- [ ] **Step 6:** Реализовать `env.ts`, `client.ts`, `testDb.ts`, конфигурации Vitest (два проекта: `unit`, `integration`) и Playwright (`webServer` на порту 3100 с базой `tms_e2e`, `globalSetup` сбрасывает схему, применяет миграции и вызывает `seedDemo` после появления задачи 23; до неё — только миграции).
- [ ] **Step 7:** `npm run test:int` — PASS. `npm run build` — без ошибок.
- [ ] **Step 8:** Commit: `chore: scaffold Next.js app with Postgres test harness`.

### Task 2: Деньги, количества, время

**Files:**
- Create: `src/domain/money.ts`, `src/domain/qty.ts`, `src/domain/time.ts` и тесты рядом (`*.test.ts`)

**Interfaces:**
- Produces:
  - `type Money = { amountKop: number; vatIncluded: boolean; vatRateBp: number }`
  - `netKop(m: Money): number` — без НДС, округление до копейки, половина вверх.
  - `grossKop(m: Money): number`
  - `parseRub(s: string): number | null` — копейки; принимает пробелы, неразрывные пробелы, запятую или точку.
  - `formatRub(kop: number): string` — `"35 500,00 ₽"`.
  - `type QtyMilli = number`; `parseQty(s: string | number): QtyMilli | null`; `formatQty(q: QtyMilli): string`.
  - `zonedToUtc(local: string, tz: string): Date` — `local` в виде `YYYY-MM-DDTHH:mm`; `formatInTz(d: Date, tz: string, pattern: string): string`.

- [ ] **Step 1:** Падающие тесты:

```ts
expect(netKop({ amountKop: 122_00, vatIncluded: true, vatRateBp: 2200 })).toBe(100_00);
expect(netKop({ amountKop: 100_00, vatIncluded: false, vatRateBp: 2200 })).toBe(100_00);
expect(grossKop({ amountKop: 100_00, vatIncluded: false, vatRateBp: 2200 })).toBe(122_00);
expect(netKop({ amountKop: 1, vatIncluded: true, vatRateBp: 2200 })).toBe(1);
expect(parseRub("1 234,56")).toBe(123_456);
expect(parseRub("41000")).toBe(4_100_000);
expect(parseRub("abc")).toBeNull();
expect(formatRub(3_550_000)).toBe("35 500,00 ₽");
expect(parseQty("1,5")).toBe(1500);
expect(parseQty(2)).toBe(2000);
expect(parseQty("-1")).toBeNull();
expect(zonedToUtc("2026-11-12T14:00", "Asia/Novosibirsk").toISOString()).toBe("2026-11-12T07:00:00.000Z");
```

- [ ] **Step 2:** `npm test` — FAIL.
- [ ] **Step 3:** Реализовать функции.
- [ ] **Step 4:** `npm test` — PASS.
- [ ] **Step 5:** Commit: `feat(domain): money, quantity and time primitives`.

### Task 3: Организации, пользователи, сессии, роли

**Files:**
- Create: `src/domain/permissions.ts` (+тест), `src/server/db/schema/org.ts`, `src/server/db/schema/misc.ts`, `src/server/db/schema/index.ts`, `src/server/auth/{password,session,context}.ts`, `src/server/services/{audit,users}.ts`, `tests/helpers/factories.ts`, `tests/integration/auth.test.ts`

**Interfaces:**
- Produces:
  - Таблицы: `organization(id, name, vat_rate_bp=2200, delivery_alloc_base 'pallets'|'weight', fleet_rule 'days'|'km', fleet_rate_kop, fuel_price_kop_per_l, driver_hour_kop, window_buffer_min=15, created_at)`; `user(id, org_id, email unique, password_hash, name, role, active)`; `session(id, user_id, token_hash, expires_at)`; `audit_log(id, org_id, actor_kind, actor_id, entity, entity_id, action, before jsonb, after jsonb, at)`; `external_ref(id, org_id, source, entity_type, entity_id, external_id, unique(org_id, source, entity_type, external_id))`.
  - `type Role = "admin" | "logist" | "warehouse" | "finance" | "manager"`
  - `type Action = "settings.manage" | "refs.read" | "refs.write" | "trips.read" | "planning.write" | "routing.calculate" | "execution.write" | "money.read" | "money.write" | "trip.close" | "export.run"`
  - `can(role: Role, action: Action): boolean`
  - `type Actor = { kind: "user"; userId: string; role: Role } | { kind: "driver_link"; linkId: string; tripId: string }`
  - `type Ctx = { db: Db; orgId: string; actor: Actor }`
  - `requireCan(ctx: Ctx, action: Action): void` — бросает `DomainError("forbidden", …)`; для `driver_link` всегда бросает.
  - `hashPassword(p: string): Promise<string>`, `verifyPassword(p: string, hash: string): Promise<boolean>` — `scrypt`.
  - `login(db: Db, email: string, password: string): Promise<{ token: string } | null>`; `ctxFromSessionToken(db: Db, token: string): Promise<Ctx | null>`; `logout(db, token)`.
  - `createOrganization(db, { orgName, adminEmail, adminPassword, adminName }): Promise<{ orgId: string; userId: string }>`
  - `createUser(ctx, { email, name, role, password })`, `setUserActive(ctx, { userId, active })`, `listUsers(ctx)`, `updateOrgSettings(ctx, patch)`, `getOrgSettings(ctx)`.
  - `audit(ctx: Ctx, e: { entity: string; entityId: string; action: string; before?: unknown; after?: unknown }): Promise<void>`
  - `tests/helpers/factories.ts`: `makeOrg(db, name?): Promise<{ orgId: string; as(role: Role): Promise<Ctx> }>`.

Матрица `can` (роли, которым действие разрешено):

| Действие | Роли |
|---|---|
| `settings.manage` | admin |
| `refs.read`, `trips.read`, `export.run` | все |
| `refs.write`, `planning.write`, `routing.calculate` | admin, logist |
| `execution.write` | admin, logist, warehouse |
| `money.read` | admin, logist, finance, manager |
| `money.write` | admin, logist, finance |
| `trip.close` | admin, finance |

`trips.read` разрешено всем ролям: складу и финансам рейс нужен для приёмки и денег. Строка «рейсы, планы, назначение» в разделе 4.4 спецификации описывает изменение, ему соответствует `planning.write`.

- [ ] **Step 1:** Падающие тесты. Модульный — вся матрица таблицей `it.each`. Интеграционные:

```ts
it("logs in with correct password only", …)          // login → token; wrong password → null
it("rejects an inactive user", …)                    // setUserActive(false) → login null
it("expires sessions", …)                            // expires_at в прошлом → ctxFromSessionToken null
it("non-admin cannot create users", …)               // logist → DomainError code "forbidden"
it("listUsers returns only own organization", …)     // две организации
it("writes audit entries for user creation", …)
```

- [ ] **Step 2:** `npm test && npm run test:int` — FAIL.
- [ ] **Step 3:** Реализовать схему, сгенерировать миграцию `npm run db:generate`, реализовать сервисы.
- [ ] **Step 4:** Тесты — PASS.
- [ ] **Step 5:** Commit: `feat: organizations, users, sessions and role permissions`.

### Task 4: Справочники

**Files:**
- Create: `src/server/db/schema/refs.ts`, `src/server/services/refs.ts`, `tests/integration/refs.test.ts`

**Interfaces:**
- Produces:
  - Таблицы: `counterparty(id, org_id, name, kind 'customer'|'carrier', inn, contacts, body_types, directions, vat_included bool, active)`; `location(id, org_id, name, address, lat, lon, tz, kind 'warehouse'|'dc'|'customer', entry_lat, entry_lon, entry_notes, pass_rules, contact, service_min, default_window_start, default_window_end, external_key, active, unique(org_id, external_key))`; `vehicle(id, org_id, plate, body_type, capacity_kg, capacity_pallets, capacity_m3, max_perm_mass_t, mass_t, axle_load_t, height_m, width_m, length_m, pass_ids int[], fuel_norm_l_100km, active)`; `driver(id, org_id, name, phone, active)`.
  - Для каждой сущности `X` из `Counterparty`, `Location`, `Vehicle`, `Driver`: `createX(ctx, input)`, `updateX(ctx, id, patch)`, `setXActive(ctx, id, active)`, `listX(ctx, { activeOnly?: boolean })`, `getX(ctx, id)`. Входные схемы zod экспортируются как `xInput`.
  - `truckProfileOf(v: VehicleRow): { profile: TruckProfile; complete: boolean }` — `complete` истинно, когда заданы `max_perm_mass_t`, `height_m`, `width_m`, `length_m`.

- [ ] **Step 1:** Падающие тесты:

```ts
it("creates and lists locations within the organization only", …)
it("rejects coordinates outside valid range", …)      // lat 91 → DomainError "validation"
it("requires refs.write", …)                          // warehouse → "forbidden"
it("deactivates instead of deleting", …)              // listVehicles({activeOnly:true}) не содержит, getVehicle возвращает
it("reports incomplete truck profile", …)             // без height_m → complete false
it("enforces unique external_key per organization", …)
```

- [ ] **Step 2:** `npm run test:int` — FAIL.
- [ ] **Step 3:** Реализовать схему, миграцию, сервисы с записью в `audit_log`.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat: reference data services`.

### Task 5: Вход, оболочка, страницы справочников

**Files:**
- Create: `src/app/login/page.tsx`, `src/app/(app)/layout.tsx`, `src/app/(app)/refs/**`, `src/app/actions/{auth,refs}.ts`, `src/components/{Nav,Table,Form,MapPicker}.tsx`, `src/server/auth/requireCtx.ts`, `e2e/helpers.ts`, `e2e/01-auth-refs.spec.ts`

**Interfaces:**
- Consumes: сервисы задач 3–4.
- Produces:
  - `requireCtx(): Promise<Ctx>` — читает cookie `tms_session` (`HttpOnly`, `Secure` вне разработки, `SameSite=Lax`); без сессии перенаправляет на `/login`.
  - Обёртка действий `action(fn)`: возвращает `{ ok: true, data } | { ok: false, code, message }`, перехватывая `DomainError`.
  - `MapPicker({ lat, lon, onChange })` — карта Leaflet, клик задаёт координаты; загружается без SSR; адрес тайлов из `env.MAP_TILE_URL`.
  - `e2e/helpers.ts`: `loginAs(page, role: Role)` — учётные записи `role@demo.local`, пароль `demo12345`.
  - Пункты меню: Планирование, Рейсы, Разобрать, Импорт, Справочники, Деньги, Настройки; пункт скрыт, если `can` запрещает чтение.

- [ ] **Step 1:** Падающий сценарий `e2e/01-auth-refs.spec.ts`: неверный пароль показывает «Неверная почта или пароль»; вход логиста открывает «Планирование»; создание точки с координатами `55.0302, 82.9204` через поля ввода и её появление в списке; роль «склад» не видит кнопку «Добавить» в справочниках. Для сценария `globalSetup` создаёт организацию и пять пользователей.
- [ ] **Step 2:** `npm run e2e -- --trace off e2e/01-auth-refs.spec.ts` — FAIL.
- [ ] **Step 3:** Реализовать страницы и действия.
- [ ] **Step 4:** Сценарий — PASS.
- [ ] **Step 5:** Commit: `feat(ui): login, app shell and reference data pages`.

---

## Фаза B. Заказы и импорт

### Task 6: Заказы и вычисляемый статус

**Files:**
- Create: `src/domain/orderStatus.ts` (+тест), `src/server/db/schema/orders.ts`, `src/server/services/orders.ts`, `tests/integration/orders.test.ts`

**Interfaces:**
- Produces:
  - Таблицы: `order(id, org_id, number, source, customer_id, location_id, window_start, window_end, cancelled, created_at, unique(org_id, source, number))`; `order_line(id, org_id, order_id, line_key, product, unit, qty_milli, weight_kg_milli, volume_m3_milli, pallets_milli, price_kop, cost_kop, unique(order_id, line_key))`.
  - `type OrderStatus = "new" | "partially_planned" | "planned" | "partially_delivered" | "delivered" | "cancelled"`
  - `deriveOrderStatus(lines: { qty: QtyMilli; allocatedOpen: QtyMilli; delivered: QtyMilli }[], cancelled: boolean): OrderStatus`
  - `upsertOrder(ctx, input: OrderInput): Promise<{ orderId: string; result: "added" | "updated" | "skipped" }>` — сравнивает поля; без изменений возвращает `skipped`.
  - `listOrders(ctx, { status?, search? }): Promise<OrderListItem[]>` — у каждой строки `remainingMilli`. В этой задаче распределений ещё нет, остаток равен количеству; учёт распределений добавляет задача 11, учёт принятого — задача 17.
  - `getOrder(ctx, id)`, `cancelOrder(ctx, id)`.

- [ ] **Step 1:** Падающие тесты:

```ts
expect(deriveOrderStatus([{ qty: 10_000, allocatedOpen: 0, delivered: 0 }], false)).toBe("new");
expect(deriveOrderStatus([{ qty: 10_000, allocatedOpen: 4_000, delivered: 0 }], false)).toBe("partially_planned");
expect(deriveOrderStatus([{ qty: 10_000, allocatedOpen: 10_000, delivered: 0 }], false)).toBe("planned");
expect(deriveOrderStatus([{ qty: 10_000, allocatedOpen: 0, delivered: 6_000 }], false)).toBe("partially_delivered");
expect(deriveOrderStatus([{ qty: 10_000, allocatedOpen: 0, delivered: 10_000 }], false)).toBe("delivered");
expect(deriveOrderStatus([{ qty: 10_000, allocatedOpen: 0, delivered: 0 }], true)).toBe("cancelled");
```

Интеграционные: `upsertOrder` дважды с теми же данными даёт `added`, затем `skipped`, и одну запись; изменение окна даёт `updated`; чужая организация заказ не видит.

- [ ] **Step 2:** FAIL. **Step 3:** Реализовать. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat: orders with derived status`.

### Task 7: Разбор файлов и сопоставление колонок

**Files:**
- Create: `src/domain/importMapping.ts` (+тест), `src/server/import/parse.ts`, `tests/integration/importParse.test.ts`

**Interfaces:**
- Produces:
  - `parseTable(bytes: Buffer, filename: string): Promise<{ sheets: { name: string; headers: string[]; rows: Record<string, unknown>[] }[] }>` — XLSX через exceljs; CSV: UTF-8 с BOM и без, при невалидном UTF-8 — Windows-1251; разделитель `;` или `,` определяется по первой строке.
  - `type OrderField = "number" | "locationKey" | "windowStart" | "windowEnd" | "qty" | "lineKey" | "product" | "unit" | "weightKg" | "volumeM3" | "pallets" | "customerName" | "priceRub" | "costRub"`
  - `type OrderMapping = { columns: Partial<Record<OrderField, string>>; dateFormat: "dd.MM.yyyy HH:mm" | "yyyy-MM-dd HH:mm"; timezone: "location" | string }`
  - `type ParsedOrderRow = { number: string; locationId: string; windowStart: Date; windowEnd: Date; lineKey: string; product: string | null; unit: string | null; qty: QtyMilli; weightKgMilli: number | null; volumeM3Milli: number | null; palletsMilli: number | null; customerName: string | null; priceKop: number | null; costKop: number | null }`
  - `type RowError = { field: OrderField | "row"; code: string; message: string }`
  - `mapOrderRow(raw: Record<string, unknown>, mapping: OrderMapping, resolveLocation: (key: string) => { id: string; tz: string } | null): { ok: true; value: ParsedOrderRow } | { ok: false; errors: RowError[] }`
  - Обязательные поля: `number`, `locationKey`, `windowStart`, `windowEnd`, `qty`. `lineKey` по умолчанию — значение `product`, при его отсутствии `"1"`. Ячейка-дата Excel (`Date`) принимается как местное время точки.

- [ ] **Step 1:** Падающие тесты:

```ts
it("maps a valid row", …)                                   // окно 12.11.2026 09:00–14:00 в Asia/Novosibirsk → 02:00Z–07:00Z
it("reports every missing required field", …)               // errors.length === 5 при пустой строке
it("reports unknown location", …)                           // code "location_not_found"
it("rejects window end before start", …)                    // code "window_order"
it("parses numbers like '1 234,5'", …)                      // qty 1_234_500
it("accepts Excel date cells", …)
it("reads Windows-1251 CSV with semicolons", …)             // заголовок «Номер заказа» читается
it("reads UTF-8 CSV with BOM", …)
it("reads XLSX and returns sheet names", …)                 // файл собирается в тесте через exceljs
```

- [ ] **Step 2:** FAIL. **Step 3:** Реализовать. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat(import): file parsing and order row mapping`.

### Task 8: Задания импорта, очередь, повторная загрузка

**Files:**
- Create: `src/server/db/schema/import.ts`, `src/server/import/{jobs,worker}.ts`, `src/instrumentation.ts`, `tests/integration/importJobs.test.ts`

**Interfaces:**
- Consumes: `parseTable`, `mapOrderRow`, `upsertOrder`.
- Produces:
  - Таблицы: `import_template(id, org_id, name, file_type 'orders', mapping jsonb)`; `import_job(id, org_id, template_id, filename, file_sha256, status 'uploaded'|'validated'|'queued'|'processing'|'done'|'failed', counts jsonb, created_by, created_at)`; `import_row(id, org_id, job_id, row_no, raw jsonb, status 'pending'|'valid'|'error'|'applied', errors jsonb, result 'added'|'updated'|'skipped'|null)`.
  - `saveTemplate(ctx, { name, mapping }): Promise<{ templateId: string }>`, `listTemplates(ctx)`.
  - `createImportJob(ctx, { filename, bytes, sheetName?, templateId }): Promise<{ jobId: string; duplicateOfJobId: string | null }>` — сам файл не хранится, строки пишутся в `import_row.raw`.
  - `validateImportJob(ctx, jobId): Promise<{ valid: number; errors: number }>` — без записи заказов.
  - `enqueueImportJob(ctx, jobId): Promise<void>`
  - `processNextJob(db: Db): Promise<boolean>` — берёт одно задание `queued` через `FOR UPDATE SKIP LOCKED`, применяет строки, пишет `counts = { added, updated, skipped, errors }`.
  - `getImportJob(ctx, jobId)`, `listImportRows(ctx, jobId, { status? })`
  - `fixImportRow(ctx, { rowId, raw }): Promise<{ status: "applied" | "error"; errors: RowError[] }>` — проверяет и применяет одну строку.
  - Источник заказа при импорте: `"template:<templateId>"`.
  - `src/instrumentation.ts`: в среде Node.js запускает цикл `processNextJob` раз в 2 секунды; в тестах не запускается.

- [ ] **Step 1:** Падающие тесты:

```ts
it("imports rows and counts results", …)                    // 3 строки двух заказов → added 2 заказа
it("does not duplicate on second upload of the same file", …) // duplicateOfJobId задан; после обработки counts.skipped = все, число заказов прежнее
it("updates changed rows on re-upload of an edited file", …) // counts.updated === 1
it("keeps error rows and applies the rest", …)              // одна строка с неизвестной точкой
it("fixes a single error row", …)                           // fixImportRow → applied, заказ появился
it("is safe to process twice", …)                           // повторный processNextJob не меняет итог
it("isolates jobs between organizations", …)
```

- [ ] **Step 2:** FAIL. **Step 3:** Реализовать. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat(import): job queue with idempotent apply and row fixing`.

### Task 9: Экран импорта

**Files:**
- Create: `src/app/(app)/import/**`, `src/app/actions/import.ts`, `samples/orders-demo.csv`, `e2e/02-import.spec.ts`

**Interfaces:**
- Consumes: сервисы задачи 8.
- Produces: шаги экрана — загрузка файла, выбор листа и шаблона, сопоставление колонок, отчёт проверки, применение, итог «Добавлено / Обновлено / Пропущено / С ошибками», таблица ошибочных строк с правкой и кнопкой «Обработать строку».

- [ ] **Step 1:** Падающий сценарий: логист загружает `samples/orders-demo.csv` (6 строк, одна с неизвестной точкой), сопоставляет колонки, сохраняет шаблон «Демо», видит «Добавлено 4», «С ошибками 1»; исправляет точку в строке и видит «Обработано»; загружает тот же файл повторно и видит «Файл уже загружался» и «Пропущено».
- [ ] **Step 2:** FAIL. **Step 3:** Реализовать. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat(ui): order import screen`.

---

## Фаза C. Планирование

### Task 10: Распределение и статусы рейса (расчёты)

**Files:**
- Create: `src/domain/allocation.ts`, `src/domain/tripStatus.ts` и тесты

**Interfaces:**
- Produces:
  - `remainingToPlan(line: { qty: QtyMilli; delivered: QtyMilli; allocatedOpen: QtyMilli }): QtyMilli`
  - `checkAllocation(remaining: QtyMilli, requested: QtyMilli): { ok: true } | { ok: false; code: "non_positive" | "exceeds_remaining" }`
  - `type TripStatus = "draft" | "planned" | "assigned" | "in_progress" | "completed" | "closed" | "cancelled"`
  - `type TripFacts = { hasCargoStops: boolean; hasCurrentPlan: boolean; executorReady: boolean; hasExecutionEvent: boolean; allStopsResolved: boolean; completenessOk: boolean; overrideReason: string | null; cancelReason: string | null }`
  - `checkTransition(from: TripStatus, to: TripStatus, f: TripFacts): { ok: true } | { ok: false; code: string }`

- [ ] **Step 1:** Падающие тесты: `remainingToPlan({qty:10_000, delivered:3_000, allocatedOpen:4_000}) === 3_000`; `checkAllocation(3_000, 3_001)` → `exceeds_remaining`; `checkAllocation(3_000, 0)` → `non_positive`; таблица переходов из раздела 8.1 спецификации — по одному разрешённому и одному запрещённому случаю на переход; `completed → closed` при `completenessOk=false` и непустой `overrideReason` разрешён; `closed → cancelled` запрещён; `draft → cancelled` без `cancelReason` запрещён.
- [ ] **Step 2:** FAIL. **Step 3:** Реализовать. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat(domain): allocation and trip status rules`.

### Task 11: Рейсы, остановки, груз

**Files:**
- Create: `src/server/db/schema/trips.ts`, `src/server/services/trips.ts`, `tests/integration/trips.test.ts`

**Interfaces:**
- Consumes: `checkAllocation`, `checkTransition`.
- Produces:
  - Таблицы: `trip(id, org_id, number, status, version int, cancel_reason, baseline_plan_version_id, mileage_km, mileage_unknown, close_override_reason, created_at, closed_at)`; `trip_stop(id, org_id, trip_id, seq, location_id, operation 'load'|'unload'|'return', actual_arrive_at, actual_depart_at, skipped_reason)`; `trip_cargo(id, org_id, trip_id, stop_id, order_line_id, qty_milli, loaded_milli)`.
  - `createTrip(ctx, { originLocationId }): Promise<{ tripId: string; number: string }>` — создаёт остановку погрузки `seq=1`.
  - `addOrderToTrip(ctx, { tripId, expectedVersion, items: { orderLineId: string; qtyMilli: QtyMilli }[] }): Promise<{ version: number }>` — блокирует строки заказа `FOR UPDATE`, проверяет остаток, создаёт остановку разгрузки для точки заказа, если её нет.
  - `removeCargo(ctx, { tripId, expectedVersion, tripCargoId })`, `reorderStops(ctx, { tripId, expectedVersion, stopIds })`
  - `getTrip(ctx, tripId): Promise<TripView>` — остановки с точками, груз, статус, версия; денежные поля отсутствуют без `money.read`.
  - `listTrips(ctx, { status?, from?, to? })`
  - `transitionTrip(ctx, { tripId, expectedVersion, to, cancelReason?, overrideReason? })` — собирает `TripFacts` и вызывает `checkTransition`.
  - Устаревшая `expectedVersion` → `DomainError("stale", …)`. Больше 10 остановок → `DomainError("too_many_stops", …)`.
  - Открытыми для расчёта остатка считаются рейсы в статусах `draft`, `planned`, `assigned`, `in_progress`.
  - Modify `src/server/services/orders.ts`: `listOrders` и `getOrder` считают `remainingMilli` с учётом распределений; `upsertOrder` при количестве строки меньше распределённого бросает `DomainError("plan_conflict", …)`.

- [ ] **Step 1:** Падающие тесты:

```ts
it("splits one order line across two trips", …)             // 10 ед.: 6 в рейс A, 4 в рейс B, остаток 0
it("puts several orders into one trip", …)                  // две точки → две остановки разгрузки
it("rejects allocation above remaining", …)                 // code "exceeds_remaining"
it("prevents concurrent over-allocation", …)                // Promise.allSettled двух addOrderToTrip по 6 из 10 → один rejected
it("rejects stale version", …)                              // code "stale"
it("limits a trip to 10 stops", …)
it("frees allocation when a trip is cancelled", …)          // остаток возвращается
it("upsertOrder rejects quantity below allocated", …)       // code "plan_conflict"
it("import row with reduced quantity becomes a plan_conflict row error", …)
it("hides other organization's trips", …)
```

- [ ] **Step 2:** FAIL. **Step 3:** Реализовать. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat: trips, stops and cargo allocation`.

### Task 12: ETA, оценка затрат, сравнение (расчёты)

**Files:**
- Create: `src/domain/{geo,eta,costEstimate,comparison}.ts` и тесты

**Interfaces:**
- Produces:
  - `haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number`
  - `apportion(totalS: number, weights: number[]): number[]` — целые, сумма равна `totalS`.
  - `type WindowState = "on_time" | "risk" | "late" | "no_window"`
  - `type StopPlan = { arriveAt: Date; waitMin: number; departAt: Date; windowState: WindowState; lateMin: number }`
  - `computeStopPlans(departureAt: Date, legDurationsS: number[], stops: { serviceMin: number; windowStart: Date | null; windowEnd: Date | null }[], bufferMin: number): StopPlan[]` — `legDurationsS[i]` ведёт к `stops[i]`.
  - `type ExpenseCategory = "fuel" | "driver" | "tolls" | "carrier" | "downtime" | "return" | "other"`
  - `type TollState = { kind: "unknown" } | { kind: "none" } | { kind: "amount"; kop: number }`
  - `type CostLine = { category: ExpenseCategory; kop: number | null; isEstimate: boolean }`
  - `type CostEstimate = { lines: CostLine[]; totalKop: number; incomplete: boolean; assumptions: string[] }`
  - `estimateOwn(i: { distanceM: number; tripDurationS: number; fuelNormLPer100Km: number | null; fuelPriceKopPerL: number; driverHourKop: number; toll: TollState; otherKop: number }): CostEstimate`
  - `estimateCarrier(i: { rate: Money; expectedDowntimeKop: number }): CostEstimate`
  - `type Option = { id: string; label: string; executor: "own" | "carrier"; stops: StopPlan[]; cost: CostEstimate }`
  - `type ComparisonRow = Option & { fits: boolean; reason: string | null }`
  - `buildComparison(options: Option[], formatTime: (d: Date) => string): ComparisonRow[]` — сначала подходящие по времени по возрастанию стоимости, затем остальные по возрастанию стоимости. Вариант не подходит, если хотя бы одна остановка в состоянии `late`; тогда `reason` имеет вид `"Опоздание 20 мин к окну до 14:00"`, где время конца окна даёт `formatTime`.

- [ ] **Step 1:** Падающие тесты:

```ts
// окно и запас
const stop = { serviceMin: 30, windowStart: t("09:00"), windowEnd: t("14:00") };
expect(computeStopPlans(t("12:35"), [3600], [stop], 15)[0].windowState).toBe("on_time"); // 13:35
expect(computeStopPlans(t("12:50"), [3600], [stop], 15)[0].windowState).toBe("risk");    // 13:50
expect(computeStopPlans(t("13:20"), [3600], [stop], 15)[0]).toMatchObject({ windowState: "late", lateMin: 20 });
// ожидание открытия окна сдвигает следующую остановку
expect(computeStopPlans(t("07:00"), [3600, 1800], [stop, stop], 15)[0]).toMatchObject({ waitMin: 60 });
expect(apportion(100, [1, 1, 1]).reduce((a, b) => a + b)).toBe(100);
// затраты: 40 км, норма 25 л/100 км, топливо 70 ₽/л, 2 часа по 600 ₽
const own = estimateOwn({ distanceM: 40_000, tripDurationS: 7200, fuelNormLPer100Km: 25, fuelPriceKopPerL: 70_00, driverHourKop: 600_00, toll: { kind: "unknown" }, otherKop: 0 });
expect(own.lines.find(l => l.category === "fuel")!.kop).toBe(700_00);
expect(own.lines.find(l => l.category === "driver")!.kop).toBe(1200_00);
expect(own.incomplete).toBe(true);
// подрядчик с НДС сравнивается на базе без НДС
expect(estimateCarrier({ rate: { amountKop: 50_020_00, vatIncluded: true, vatRateBp: 2200 }, expectedDowntimeKop: 0 }).totalKop).toBe(41_000_00);
```

Пример PRD: три варианта — своя машина по платной дороге (ETA 13:35, 35 500 ₽), своя без платных (ETA 14:20, 32 000 ₽), подрядчик (ETA 13:45, 41 000 ₽), окно до 14:00, запас 15 минут. Ожидание: `fits` у первого и третьего; порядок — 35 500, 41 000, 32 000; у варианта за 32 000 `reason` содержит `"Опоздание 20 мин"`.

- [ ] **Step 2:** FAIL. **Step 3:** Реализовать. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat(domain): ETA, cost estimate and option comparison`.

### Task 13: Провайдеры маршрутизации

**Files:**
- Create: `src/server/routing/{types,synthetic,twogis,wkt,quota,variantToken,index}.ts`, `tests/integration/routing.test.ts`, `src/server/routing/twogis.test.ts`, `src/server/routing/fixtures/*.ts`; дополнить `src/server/db/schema/misc.ts` таблицей `routing_request_log`

**Interfaces:**
- Produces:
  - Типы `RouteRequest`, `RouteResult`, `RouteFailure`, `RoutingProvider` — как в разделе 6.1 спецификации.
  - `type TruckProfile = { maxPermMassT?: number; massT?: number; axleLoadT?: number; heightM?: number; widthM?: number; lengthM?: number; passIds?: number[] }`
  - `type RouteVariant = { id: string; source: "2gis" | "synthetic"; distanceM: number; durationS: number; legDurationsS: number[]; legsEstimated: boolean; geometry: [number, number][][] }`
  - `createSyntheticProvider(opts?: { speedKmh?: number; detour?: number }): RoutingProvider` — по умолчанию 30 км/ч и коэффициент 1.3; возвращает основной вариант и второй с расстоянием +15 % и временем −10 %; геометрия — прямые отрезки.
  - `buildTwoGisBody(req: RouteRequest, now: Date): Record<string, unknown>`
  - `parseTwoGisResponse(httpStatus: number, body: unknown, pointCount: number, straightLegsM: number[]): RouteResult`
  - `createTwoGisProvider(opts: { apiKey: string; fetchFn?: typeof fetch; timeoutMs?: number }): RoutingProvider` — таймаут по умолчанию 10 000 мс, повторов нет.
  - `parseLineStringWkt(s: string): [number, number][]` — пары `[lat, lon]`; третья координата отбрасывается.
  - `getRoutingProvider(): RoutingProvider` — по `env.ROUTING_MODE`; `live` без ключа возвращает провайдер, отвечающий `no_key`.
  - `recordRoutingRequest(ctx, { ok: boolean; reason?: RouteFailure }): Promise<void>`; `getQuota(ctx): Promise<{ used: number; limit: number; expiresAt: Date | null }>` — `used` считает успешные живые запросы.
  - `sealVariant(v: SealedVariant): string`, `openVariant(token: string): SealedVariant | null` — HMAC-SHA256 на `SESSION_SECRET`, срок 2 часа; `type SealedVariant = { source: "2gis" | "synthetic"; distanceM: number; durationS: number; legDurationsS: number[]; legsEstimated: boolean; tollFiltered: boolean; profileComplete: boolean }`.
- Тело запроса 2ГИС: `points: [{ type: "stop", lon, lat }]`, `transport: "truck"`, `output: "detailed"`, `locale: "ru"`, `alternative: req.alternatives`, `filters: req.avoid` (если не пусто), `params.truck` с полями `max_perm_mass`, `mass`, `axle_load`, `height`, `width`, `length`, `pass_zone_pass_ids` (только заданные). Выезд позже `now` более чем на 5 минут: `traffic_mode: "statistics"`, `utc: <секунды>`; иначе `traffic_mode: "jam"`.
- Разбор ответа: `status: "OK"` и массив `result`; у варианта `total_distance` (метры), `total_duration` (секунды), геометрия в `maneuvers[].outcoming_path.geometry[].selection`. Время по участкам: если форма ответа его не даёт — `apportion(total_duration, straightLegsM)` и `legsEstimated: true`.
- Соответствие причин — таблица раздела 6.2 спецификации. Тело не-JSON или без `status` → `unavailable`.

- [ ] **Step 1:** Падающие тесты:

```ts
it("builds a truck request with only provided profile fields", …)   // нет height_m → нет params.truck.height
it("uses statistics traffic mode for future departure", …)          // utc равен секундам departureAt
it("uses jam traffic mode for immediate departure", …)
it("adds toll_road filter when requested", …)
it("parses variants with distance, duration and geometry", …)       // синтетический ответ из 2 вариантов
it("estimates leg durations when response has no per-leg data", …)  // сумма равна total_duration, legsEstimated true
it.each([["ROUTE_NOT_FOUND","not_found"],["ROUTE_DOES_NOT_EXISTS","not_found"],["ATTRACT_FAIL","point_off_road"],["POINT_EXCLUDED","bad_request"],["FAIL","unavailable"]])
it.each([[401,"key_rejected"],[403,"key_rejected"],[429,"quota"],[500,"unavailable"]])
it("returns unavailable for HTML, empty and unexpected JSON bodies", …)
it("returns timeout when fetch exceeds timeoutMs", …)               // fetchFn никогда не отвечает, timeoutMs 20
it("counts only successful live requests in quota", …)
it("rejects a tampered or expired variant token", …)
it("synthetic provider returns two variants within the 10 point limit", …)
it("never includes the API key in thrown errors or results", …)
```

- [ ] **Step 2:** FAIL. **Step 3:** Реализовать; миграция для `routing_request_log(id, org_id, user_id, at, ok, reason)`. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat(routing): provider interface, synthetic and 2GIS adapters, quota`.

### Task 14: Расчёт вариантов, версии плана, предложения, назначение

**Files:**
- Create: `src/server/services/{planning,offers}.ts`, `tests/integration/planning.test.ts`; дополнить `src/server/db/schema/trips.ts` таблицами `plan_version`, `carrier_offer`; дополнить `src/server/db/schema/money.ts` таблицей `expense` (полное описание — задача 19)

**Interfaces:**
- Consumes: задачи 11–13.
- Produces:
  - Таблицы: `plan_version(id, org_id, trip_id, version_no, is_current, created_by, created_at, reason, executor 'own'|'carrier', vehicle_id, driver_id, carrier_offer_id, departure_at, distance_m, duration_s, metrics_source '2gis'|'synthetic'|'manual', toll_filtered, profile_complete, legs_estimated, stops_snapshot jsonb, cost_lines jsonb, assumptions jsonb, total_kop, incomplete)`; `carrier_offer(id, org_id, trip_id, carrier_id, rate_kop, vat_included, vat_rate_bp, vehicle_descr, confirmed_arrive_at, downtime_terms, expected_downtime_kop, valid_until, source, status 'candidate'|'quoted'|'confirmed'|'rejected')`.
  - `calculateRoutes(ctx, { tripId, departureAt: Date, vehicleId: string | null, avoidToll: boolean }): Promise<{ result: { ok: true; variants: ClientVariant[] } | { ok: false; reason: RouteFailure; message: string }; quota: Quota; warnings: string[] }>` — `ClientVariant = RouteVariant & { token: string; stops: StopPlan[]; tollFiltered: boolean; profileComplete: boolean }`. Точки — остановки рейса по порядку; у точки с `entry_lat` берётся точка въезда. Предупреждение, если расстояние по прямой между соседними точками больше 50 000 м и режим `live`. При исчерпанном лимите возвращает `quota` без запроса.
  - `listExecutorOptions(ctx, { tripId, variants: { token: string; toll: TollState; otherKop: number }[] }): Promise<ComparisonRow[]>` — каждый вариант × (подходящие свои машины + предложения в статусах `quoted`, `confirmed`). Своя машина подходит, если активна, вместимость не меньше груза по заданным мерам и нет пересечения с другим открытым рейсом.
  - `savePlan(ctx, { tripId, expectedVersion, reason: string | null, executor: { kind: "own"; vehicleId: string; driverId: string } | { kind: "carrier"; offerId: string }, departureAt: Date, route: { kind: "sealed"; token: string } | { kind: "manual"; distanceM: number; durationS: number }, toll: TollState, otherKop: number }): Promise<{ planVersionId: string; versionNo: number }>` — снимает `is_current` с прежней версии; `reason` обязателен, начиная со второй версии; пишет плановые строки `expense` с `kind='plan'`; смена исполнителя у рейса в статусе `assigned` возвращает статус `planned`. При `ROUTE_METRICS_STORAGE=none` и источнике `2gis` — `DomainError("provider_metrics_not_storable", …)`.
  - `listPlanVersions(ctx, tripId)`, `assignTrip(ctx, { tripId, expectedVersion })` — переводит в `assigned`, при первом назначении записывает `baseline_plan_version_id`.
  - `addCarrierOffer(ctx, input)`, `setOfferStatus(ctx, { offerId, status })`, `listOffers(ctx, tripId)`.

- [ ] **Step 1:** Падающие тесты:

```ts
it("calculates variants with stop plans in synthetic mode", …)
it("uses the entry point of a distribution center", …)             // координаты запроса равны entry_lat/entry_lon (провайдер-заглушка)
it("returns quota failure without calling the provider when limit is reached", …)
it("lists own vehicles and quoted offers as options", …)
it("excludes a vehicle busy on an overlapping trip", …)
it("excludes an inactive vehicle from options", …)
it("saves plan version 1 and moves trip to planned", …)
it("requires a reason from version 2 and keeps version 1 unchanged", …)
it("keeps the saved snapshot after location coordinates change", …) // stops_snapshot прежний
it("keeps the saved plan after its vehicle is deactivated", …)
it("stores manual metrics with source manual", …)
it("refuses to store 2GIS metrics when storage is none", …)
it("returns trip to planned when executor changes after assignment", …)
it("assign requires a confirmed offer for a carrier", …)
it("sets baseline plan on first assignment only", …)
it("warehouse cannot calculate routes", …)
```

- [ ] **Step 2:** FAIL. **Step 3:** Реализовать. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat: route calculation, plan versions, carrier offers and assignment`.

### Task 15: Экран планирования, список и карточка рейса («План»)

**Files:**
- Create: `src/app/(app)/planning/**`, `src/app/(app)/trips/**`, `src/app/actions/{trips,planning}.ts`, `src/components/{RouteMap,ComparisonTable,QuotaBadge,TwoGisAttribution}.tsx`, `e2e/03-planning.spec.ts`

**Interfaces:**
- Consumes: сервисы задач 6, 11, 14.
- Produces:
  - `/planning`: слева очередь заказов с остатком по строкам, в центре карта с точками и линиями вариантов, справа состав рейса и таблица сравнения. Кнопки: «Создать рейс», «Добавить в рейс» с вводом количества, «Рассчитать маршрут», «Вариант без платных дорог», «Ввести оценку вручную», «Сохранить план», «Назначить».
  - `QuotaBadge` показывает «Использовано N из 1000» и дату окончания ключа; в синтетическом режиме — «Демо-расчёт, не 2ГИС».
  - `TwoGisAttribution` выводится при `source === "2gis"`.
  - В таблице сравнения: исполнитель, ETA по остановкам, состояние по окну цветом и текстом, стоимость, пометки «оценка», «неполная», «профиль неполный», причина непригодности.
  - `/trips` — список с фильтрами; `/trips/[id]` — вкладки; в этой задаче работает «План»: версии, причина, исполнитель, остановки с ETA, оценка затрат, допущения; кнопка «Перепланировать» с обязательной причиной.

- [ ] **Step 1:** Падающий сценарий: логист создаёт рейс со склада, добавляет 6 из 10 единиц заказа, видит остаток 4; добавляет второй заказ; нажимает «Рассчитать маршрут» и видит два варианта с пометкой «Демо-расчёт, не 2ГИС»; выбирает машину, сохраняет план, статус «Запланирован»; назначает, статус «Назначен»; перепланирует с причиной «Сдвиг окна» и видит версии 1 и 2 во вкладке «План»; создаёт второй рейс и добавляет оставшиеся 4 единицы.
- [ ] **Step 2:** FAIL. **Step 3:** Реализовать. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat(ui): planning workspace, trip list and plan tab`.

---

## Фаза D. Исполнение

### Task 16: Ссылка водителя и события исполнения

**Files:**
- Create: `src/domain/yandexLinks.ts` (+тест), `src/server/auth/rateLimit.ts`, `src/server/services/{shareLinks,execution}.ts`, `src/app/d/[token]/**`, `tests/integration/execution.test.ts`; дополнить `src/server/db/schema/trips.ts` таблицами `share_link`, `trip_event`

**Interfaces:**
- Produces:
  - Таблицы: `share_link(id, org_id, trip_id, token_hash, expires_at, revoked_at)`; `trip_event(id, org_id, trip_id, stop_id, type, at, source 'user'|'link', actor_id)`.
  - `type TripEventType = "driver_confirmed" | "loading_started" | "loaded" | "departed" | "arrived" | "unloaded" | "stop_skipped" | "completed"`
  - `createShareLink(ctx, { tripId, ttlDays?: number }): Promise<{ token: string; expiresAt: Date }>` — 32 случайных байта в base64url; в базе SHA-256.
  - `revokeShareLink(ctx, linkId)`, `ctxFromShareToken(db: Db, token: string): Promise<Ctx | null>` — `null` для неизвестного, просроченного, отозванного токена и для рейса в статусе `cancelled`.
  - `getDriverView(ctx): Promise<DriverView>` — номер рейса, остановки по порядку: название, адрес, заметки о въезде, правила пропуска, контакт, окно, операция; ссылки Яндекса. Денежных полей, ставок и данных других рейсов нет.
  - `recordEvent(ctx, { tripId, type, stopId?, at?: Date, skippedReason?: string }): Promise<void>` — для `driver_link` разрешены `driver_confirmed`, `arrived`, `loaded`, `unloaded` и только свой рейс; первое событие переводит `assigned → in_progress`; `arrived` и `unloaded` заполняют фактическое время остановки; когда все остановки закрыты, рейс переходит в `completed`. На рейсе в статусах `completed`, `closed`, `cancelled` — `DomainError("trip_not_active", …)`.
  - `confirmLoading(ctx, { tripId, items: { tripCargoId: string; loadedMilli: QtyMilli }[] })`, `setStopFact(ctx, { stopId, arriveAt?, departAt? })`, `setMileage(ctx, { tripId, km: number | null, unknown: boolean })`.
  - `rateLimit(key: string, perMinute: number): boolean` — в памяти процесса; для ссылки 60 в минуту.
  - `yandexMapsRouteUrl(points: { lat: number; lon: number }[]): string`, `yandexNavigatorUrl(points): string`.

- [ ] **Step 1:** Сверить формат ссылок Яндекс Карт и Навигатора с документацией (ссылки в PRD, раздел «Источники»). Если хост закрыт сетевой политикой — запросить доступ; до сверки ссылку Навигатора не выводить.
- [ ] **Step 2:** Падающие тесты:

```ts
it("resolves a valid token to a driver context for that trip only", …)
it.each(["expired", "revoked", "cancelled trip", "unknown"])("rejects %s link", …)   // ctxFromShareToken → null
it("driver view contains no money fields", …)               // JSON.stringify(view) не содержит "kop", "rate"
it("driver cannot record events for another trip", …)       // code "forbidden"
it("driver cannot record a 'departed' event type outside the allowed set", …)
it("first event moves trip to in_progress", …)
it("trip completes when every stop is resolved", …)
it("rejects events on a completed trip", …)                 // code "trip_not_active"
it("stores only the token hash", …)
it("rate limiter blocks the 61st request in a minute", …)
```

- [ ] **Step 3:** FAIL. **Step 4:** Реализовать сервисы и страницу `/d/[token]`: недействительная ссылка показывает «Ссылка недействительна» со статусом 404; текст «Яндекс может построить другой путь. Проверьте грузовой профиль в приложении». **Step 5:** PASS.
- [ ] **Step 6:** Commit: `feat: driver share link and execution events`.

### Task 17: Приёмка и задачи

**Files:**
- Create: `src/server/services/{acceptance,tasks}.ts`, `tests/integration/acceptance.test.ts`; дополнить `src/server/db/schema/trips.ts` таблицами `acceptance`, `task`

**Interfaces:**
- Produces:
  - Таблицы: `acceptance(id, org_id, trip_cargo_id, version_no, is_current, accepted_milli, rejected_milli, returned_milli, reason_code, confirmation, created_by, created_at)`; `task(id, org_id, type 'shortfall'|'rejection'|'return'|'bill_surcharge'|'other', trip_id, order_id, title, responsible_user_id, due_at, status 'open'|'done', resolution, created_at)`.
  - `type ReasonCode = "shortage" | "damage" | "quality" | "docs_mismatch" | "refused" | "other"`
  - `recordAcceptance(ctx, { tripCargoId, acceptedMilli, rejectedMilli, returnedMilli, reasonCode?: ReasonCode, confirmation?: string, responsibleUserId?: string, dueAt?: Date }): Promise<{ versionNo: number; taskId: string | null }>` — сумма трёх величин не больше `loaded_milli` (или `qty_milli`, если погрузка не подтверждена); при `accepted < loaded` обязателен `reasonCode` и создаётся задача; повтор создаёт новую версию.
  - `listAcceptance(ctx, tripId)` — текущие версии и история.
  - `deliveredByLine(ctx, orderLineIds: string[]): Promise<Map<string, QtyMilli>>` — сумма `accepted_milli` текущих версий; используется в `listOrders` для остатка.
  - `createTask(ctx, input)`, `completeTask(ctx, { taskId, resolution })`, `listTasks(ctx, { status?, tripId? })`.

- [ ] **Step 1:** Падающие тесты:

```ts
it("records full acceptance without a task", …)
it("partial acceptance requires a reason and creates a task", …)   // без reasonCode → "reason_required"
it("keeps the remainder plannable after the trip completes", …)    // 10 отгружено, 7 принято → остаток заказа 3
it("does not change the ordered quantity", …)
it("creates a new version and keeps the previous one", …)
it("rejects totals above loaded quantity", …)
it("finance role cannot record acceptance", …)
```

- [ ] **Step 2:** FAIL. **Step 3:** Реализовать. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat: acceptance versions and deviation tasks`.

### Task 18: Вкладки «Исполнение» и «Приёмка»

**Files:**
- Create: вкладки в `src/app/(app)/trips/[id]/`, `src/app/actions/{execution,acceptance}.ts`, `e2e/04-execution.spec.ts`

**Interfaces:**
- Consumes: сервисы задач 16–17.
- Produces: «Исполнение» — создание и отзыв ссылки водителя с копированием адреса, подтверждение погрузки, лента событий, фактическое время по остановкам, пробег или отметка «неизвестен». «Приёмка» — таблица строк груза с вводом «принято / отклонено / возвращено», кодом причины, подтверждением, ответственным и сроком; история версий.

- [ ] **Step 1:** Падающий сценарий: логист создаёт ссылку; в новом контексте браузера без входа страница `/d/<token>` показывает две остановки и не содержит символа «₽»; водитель нажимает «Подтвердить назначение», «Прибыл», «Разгружен» по остановкам; у логиста статус «Выполнен»; склад вводит приёмку 7 из 10 с причиной «Недостача» и видит созданную задачу; отозванная ссылка показывает «Ссылка недействительна».
- [ ] **Step 2:** FAIL. **Step 3:** Реализовать. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat(ui): execution and acceptance tabs, driver page`.

---

## Фаза E. Деньги

### Task 19: Экономика, сверка, полнота (расчёты)

**Files:**
- Create: `src/domain/{economics,reconciliation,completeness}.ts` и тесты

**Interfaces:**
- Produces:
  - `type ExpenseLine = { category: ExpenseCategory; kop: number | null }` — `null` означает «неизвестно».
  - `type Side = { directKop: number; marginKop: number | null; afterFleetKop: number | null; incomplete: boolean }`
  - `tripResult(i: { revenueKop: number | null; surchargesKop: number; plan: ExpenseLine[]; fact: ExpenseLine[]; fleetPlanKop: number | null; fleetFactKop: number | null }): { plan: Side; fact: Side; deviation: { category: ExpenseCategory; kop: number }[]; deviationTotalKop: number }` — `marginKop` и `afterFleetKop` равны `null`, когда выручка неизвестна.
  - `fleetOverheadKop(rule: "days" | "km", rateKop: number, i: { days: number; km: number | null }): number | null`
  - `allocateByWeight(totalKop: number, parts: { id: string; weight: number }[]): { id: string; kop: number }[] | null` — сумма равна `totalKop`; остаток от округления получает часть с наибольшим весом; `null`, если у какой-то части вес равен нулю.
  - `orderMarginKop(lines: { qty: QtyMilli; priceKop: number | null; costKop: number | null }[], deliveryKop: number): number | null`
  - `invoiceBalance(amountKop: number, allocationsKop: number[]): { paidKop: number; remainingKop: number; state: "unpaid" | "partially_paid" | "paid" }`
  - `checkPaymentAllocation(i: { paymentKop: number; alreadyAllocatedKop: number; invoiceRemainingKop: number; requestedKop: number }): { ok: true } | { ok: false; code: "non_positive" | "exceeds_payment" | "exceeds_invoice" }`
  - `suggestInvoices(p: { counterpartyId: string; amountKop: number; purpose: string }, open: { id: string; counterpartyId: string; number: string; remainingKop: number }[]): { invoiceId: string; why: "number_in_purpose" | "exact_amount" }[]`
  - `type CompletenessCode = "acceptance_missing" | "mileage_missing" | "fact_expense_missing" | "unverified_expense" | "unbilled_surcharge" | "open_task"`
  - `checkCompleteness(i: { cargoWithoutAcceptance: number; mileageKnownOrMarked: boolean; planCategoriesWithoutFact: ExpenseCategory[]; unverifiedExpenses: number; unbilledSurcharges: number; openTasks: number }): { ok: boolean; failed: CompletenessCode[] }`

- [ ] **Step 1:** Падающие тесты. Пример PRD:

```ts
const r = tripResult({
  revenueKop: 112_000_00, surchargesKop: 0,
  plan: [{ category: "fuel", kop: 30_000_00 }, { category: "driver", kop: 20_000_00 }, { category: "tolls", kop: 10_000_00 }],
  fact: [{ category: "fuel", kop: 34_500_00 }, { category: "driver", kop: 20_000_00 }, { category: "tolls", kop: 11_000_00 }, { category: "downtime", kop: 6_000_00 }],
  fleetPlanKop: 18_000_00, fleetFactKop: 18_000_00,
});
expect(r.plan).toMatchObject({ directKop: 60_000_00, marginKop: 52_000_00, afterFleetKop: 34_000_00 });
expect(r.fact).toMatchObject({ directKop: 71_500_00, marginKop: 40_500_00, afterFleetKop: 22_500_00 });
expect(r.deviation).toEqual([
  { category: "fuel", kop: 4_500_00 }, { category: "tolls", kop: 1_000_00 }, { category: "downtime", kop: 6_000_00 },
]);
expect(invoiceBalance(112_000_00, [80_000_00])).toEqual({ paidKop: 80_000_00, remainingKop: 32_000_00, state: "partially_paid" });
```

Остальные: неизвестная статья (`kop: null`) даёт `incomplete: true` и не считается нулём; без выручки `marginKop === null`; `allocateByWeight(100_00, [{id:"a",weight:1},{id:"b",weight:1},{id:"c",weight:1}])` даёт сумму `100_00` и остаток у первой из равных; нулевой вес → `null`; `suggestInvoices` находит счёт по номеру в назначении и по точной сумме, возвращает два результата при двух счетах с одинаковой суммой; каждая из шести причин неполноты по отдельности; пустой набор → `ok: true`.

- [ ] **Step 2:** FAIL. **Step 3:** Реализовать. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat(domain): trip economics, reconciliation and completeness`.

### Task 20: Расходы, начисления, счета, оплаты, документы, закрытие

**Files:**
- Modify: `src/server/db/schema/money.ts` — к таблице `expense` из задачи 14 добавляются остальные
- Create: `src/server/services/{finance,economics,close}.ts`, `tests/integration/finance.test.ts`

**Interfaces:**
- Consumes: задачи 14, 17, 19.
- Produces:
  - Таблицы: `expense(id, org_id, trip_id, vehicle_id, document_id, plan_version_id, kind 'plan'|'fact', category, amount_kop, vat_included, vat_rate_bp, date, source, is_estimate, not_incurred, check_status 'unverified'|'verified')`; `accrual(id, org_id, trip_id, kind 'revenue'|'surcharge', description, amount_kop, vat_included, vat_rate_bp, state 'agreed'|'invoiced', invoice_id)`; `invoice(id, org_id, direction 'outgoing'|'incoming', counterparty_id, trip_id, number, date, due_date, amount_kop, vat_included, vat_rate_bp)`; `payment(id, org_id, direction, counterparty_id, date, amount_kop, purpose, state 'unallocated'|'needs_review'|'partially_allocated'|'allocated')`; `payment_allocation(id, org_id, payment_id, invoice_id, amount_kop)`; `document(id, org_id, trip_id, kind, number, operator_ref, status, log jsonb)`.
  - `addExpense(ctx, input)`, `verifyExpense(ctx, expenseId)`, `markNotIncurred(ctx, { tripId, category })`, `linkExpense(ctx, { expenseId, tripId })`
  - `addAccrual(ctx, input)`, `createInvoice(ctx, { direction, counterpartyId, tripId?, number, date, dueDate, amount: Money, accrualIds?: string[] })` — помечает начисления `invoiced`.
  - `recordPayment(ctx, { direction, counterpartyId, date, amountKop, purpose }): Promise<{ paymentId: string; state: "unallocated" | "needs_review"; suggestions: … }>` — ровно одно предложение → `unallocated`; иначе `needs_review`. Автоматического распределения нет.
  - `allocatePayment(ctx, { paymentId, invoiceId, amountKop })`, `listInvoices(ctx, filter)`, `listPayments(ctx, filter)`
  - `addDocument(ctx, input)`, `setDocumentStatus(ctx, { documentId, status })`
  - `getTripEconomics(ctx, tripId): Promise<TripEconomicsView>` — `tripResult` на базе без НДС; плановые строки — из `baseline_plan_version_id`; расходы парка по настройке организации; распределение по заказам на базе `delivery_alloc_base`; маржа заказов; счета и остатки долга; для каждой строки отклонения — идентификаторы исходных расходов.
  - `getCompleteness(ctx, tripId)`, `closeTrip(ctx, { tripId, expectedVersion, overrideReason?: string })` — при неполноте без причины `DomainError("incomplete", …)` со списком кодов; с причиной закрывает и пишет в журнал причину и коды.
  - Все функции записи требуют `money.write`, `closeTrip` — `trip.close`, чтение — `money.read`.

- [ ] **Step 1:** Падающие тесты:

```ts
it("computes plan/fact from baseline plan and fact expenses", …)
it("partial payment changes debt and keeps trip result", …)        // getTripEconomics до и после allocatePayment: fact одинаков, remainingKop 32_000_00
it("payment matching two invoices needs review and closes nothing", …)
it("unallocated payment leaves invoice unpaid", …)
it("rejects allocation above payment or invoice remainder", …)
it("allocates one payment across two invoices and two payments to one invoice", …)
it("marks agreed surcharge without invoice as unbilled", …)        // getCompleteness содержит "unbilled_surcharge"
it("normalizes VAT-inclusive carrier invoice to net", …)
it("allocates delivery cost to orders by pallets", …)
it("deviation line exposes source expense ids", …)
it("refuses to close an incomplete trip without a reason", …)      // code "incomplete"
it("closes with override and records reason and failed checks in audit", …)
it("logist cannot close; warehouse cannot read economics", …)
it("isolates money between organizations", …)
```

- [ ] **Step 2:** FAIL. **Step 3:** Реализовать. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat: expenses, invoices, payments, economics and financial close`.

### Task 21: Вкладки «Деньги», «Документы», «История» и экран «Деньги»

**Files:**
- Create: вкладки в `src/app/(app)/trips/[id]/`, `src/app/(app)/money/**`, `src/app/actions/finance.ts`, `e2e/05-money.spec.ts`

**Interfaces:**
- Consumes: сервисы задачи 20, `audit_log`.
- Produces: «Деньги» — таблица план-факт по статьям с отклонением и раскрытием исходных расходов, результат до и после расходов парка, распределение по заказам, начисления, счета с остатком долга отдельным блоком, список проверки полноты, кнопка «Закрыть рейс» с полем причины при неполноте. «Документы» — номер, ссылка, статус. «История» — записи журнала. `/money` — счета, платежи, распределение платежа по счетам, пометка «Требует проверки».

- [ ] **Step 1:** Падающий сценарий: финансы открывают выполненный рейс, добавляют фактические расходы, отмечают их проверенными, создают счёт на 112 000 ₽, вносят оплату 80 000 ₽ и распределяют её; блок долга показывает «32 000,00 ₽», результат рейса не меняется; закрытие без причины показывает список невыполненных пунктов; закрытие с причиной переводит рейс в «Финансово закрыт»; во вкладке «История» видна причина; роль «склад» вкладку «Деньги» не видит.
- [ ] **Step 2:** FAIL. **Step 3:** Реализовать. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat(ui): money, documents and history tabs, payments screen`.

---

## Фаза F. Сквозные части

### Task 22: «Разобрать» и экспорт

**Files:**
- Create: `src/server/services/triage.ts`, `src/server/export/{datasets,writers}.ts`, `src/app/(app)/triage/**`, `src/app/api/export/route.ts`, `tests/integration/{triage,export}.test.ts`

**Interfaces:**
- Produces:
  - `type TriageKind = "late_risk" | "late_fact" | "partial_acceptance" | "unlinked_expense" | "unbilled_surcharge" | "overdue_invoice" | "payment_needs_review" | "import_errors"`
  - `getTriage(ctx): Promise<{ kind: TriageKind; title: string; entity: { type: string; id: string }; dueAt: Date | null }[]>` — денежные виды только при `money.read`.
  - `type Dataset = "orders" | "trips" | "acceptance" | "plan_fact" | "invoices_payments"`
  - `exportDataset(ctx, dataset: Dataset, format: "xlsx" | "csv"): Promise<{ filename: string; contentType: string; body: Buffer }>` — в каждой выгрузке внутренний и внешний номера, время создания, источник значения; CSV в UTF-8 с BOM и разделителем `;`; денежные колонки и наборы `plan_fact`, `invoices_payments` требуют `money.read`; при `EXPORT_PROVIDER_METRICS=false` расстояние и время пусты для строк с источником `2gis`.
  - `GET /api/export?dataset=…&format=…` — отдаёт файл; проверяет сессию.

- [ ] **Step 1:** Падающие тесты: по одному на каждый вид `TriageKind` (создаётся условие, элемент появляется; после устранения исчезает); склад не получает денежные виды; выгрузка `orders` в XLSX читается exceljs и содержит внешний номер; CSV начинается с BOM; склад получает `forbidden` на `plan_fact`; строка плана с источником `2gis` имеет пустые расстояние и время, с источником `manual` — заполненные; чужая организация в выгрузку не попадает.
- [ ] **Step 2:** FAIL. **Step 3:** Реализовать сервисы, страницу и обработчик. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat: triage queue and XLSX/CSV export`.

### Task 23: Настройки, демо-данные, запуск

**Files:**
- Create: `src/app/(app)/settings/**`, `src/app/actions/settings.ts`, `scripts/seed.ts`, `samples/orders-demo.xlsx` (создаётся скриптом), `Dockerfile`, `docker-compose.yml`, `README.md`, `tests/integration/seed.test.ts`

**Interfaces:**
- Consumes: сервисы задач 3, 4, 8.
- Produces:
  - `seedDemo(db: Db): Promise<{ orgId: string }>` — организация «Демо-поставщик»; пользователи `admin|logist|warehouse|finance|manager@demo.local` с паролем из `SEED_PASSWORD` (по умолчанию `demo12345`); склад, распределительный центр с точкой въезда и окном до 14:00, пять получателей в Новосибирске; три машины (у одной профиль неполный), три водителя, два перевозчика; шаблон импорта «Демо». Повторный вызов не создаёт дублей. Расстояние по прямой между любыми двумя точками меньше 50 км.
  - `/settings`: пользователи, правила расчёта (ставка НДС, база распределения, правило и ставка расходов парка, цена топлива, стоимость часа водителя, запас по окну), шаблоны импорта. Доступ — `settings.manage`.
  - `docker-compose.yml`: сервисы `db` (postgres:16, том данных) и `app` (сборка `output: "standalone"`, миграции при старте).
  - `README.md`: запуск локально и через Docker Compose, переменные окружения, включение живого режима 2ГИС, список открытых вопросов из раздела 17 спецификации.

- [ ] **Step 1:** Падающие тесты: `seedDemo` дважды даёт одну организацию и пять пользователей; все пары точек ближе 50 000 м по `haversineM`; `samples/orders-demo.xlsx` проходит `validateImportJob` с шаблоном «Демо» с одной намеренно ошибочной строкой.
- [ ] **Step 2:** FAIL. **Step 3:** Реализовать; подключить `seedDemo` в `globalSetup` Playwright; убрать временное создание пользователей из задачи 5. **Step 4:** PASS; все прежние сценарии `e2e` проходят.
- [ ] **Step 5:** Проверить запуск сборки: `npm run build`, затем старт собранного сервера с базой `tms_dev` и ответ `200` на `/login`. Сборку образа Docker проверить командой `docker compose build`, если демон доступен; если нет — записать в README, что образ не проверялся в среде разработки.
- [ ] **Step 6:** Commit: `feat: settings, demo seed and Docker Compose setup`.

### Task 24: Сквозной сценарий и итоговая проверка

**Files:**
- Create: `e2e/06-full-scenario.spec.ts`, `tests/integration/isolation.test.ts`

**Interfaces:**
- Consumes: всё предыдущее.

- [ ] **Step 1:** Падающий тест изоляции: для двух организаций вызвать каждую экспортируемую функцию чтения из `src/server/services/*` и `exportDataset` от имени второй организации с идентификаторами первой; ожидание — пустой результат либо `DomainError` с кодом `not_found`. Список функций собирается перебором экспортов модулей, чтобы новая функция без проверки роняла тест.
- [ ] **Step 2:** Падающий сквозной сценарий на демо-данных: импорт `samples/orders-demo.xlsx` → рейс из двух заказов с делением одного заказа → расчёт и сохранение плана → назначение → ссылка водителя и отметки → приёмка с недостачей → расходы, счёт, частичная оплата → закрытие с причиной → экспорт `plan_fact.xlsx` скачивается → экран «Разобрать» показывает задачу по недостаче.
- [ ] **Step 3:** Довести оба теста до PASS, исправляя найденное.
- [ ] **Step 4:** Полная проверка: `npm run lint && npm test && npm run test:int && npm run e2e -- --trace off && npm run build` — всё без ошибок.
- [ ] **Step 5:** Пройти таблицу раздела 15 спецификации и для каждого критерия записать в README имя теста, который его подтверждает.
- [ ] **Step 6:** Commit: `test: full scenario and organization isolation sweep`; `git push -u origin claude/intelligent-lovelace-lzkbvh`.

---

## Вне плана

- Проверка живым ключом 2ГИС (раздел 14 спецификации) выполняется после создания ключа владельцем продукта: один прогон по списку, результаты — в README. Коды ошибок для превышения 50 км и лимита демо-ключа, а также наличие времени по участкам уточняются в `parseTwoGisResponse` по итогам прогона.
- Вопросы раздела 17 спецификации решаются не кодом.
