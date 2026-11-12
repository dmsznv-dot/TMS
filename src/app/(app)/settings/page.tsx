import { Forbidden } from "@/components/Forbidden";
import { Badge, Card, PageHeader, tableClass, tdClass, thClass } from "@/components/ui";
import { can, ROLE_LABELS } from "@/domain/permissions";
import { requireCtx } from "@/server/auth/requireCtx";
import { listTemplates } from "@/server/import/jobs";
import { getOrgSettings, listUsers } from "@/server/services/users";
import { CreateUserForm, SettingsForm, UserActiveButton } from "./SettingsForms";

export default async function SettingsPage() {
  const ctx = await requireCtx();
  if (!can(ctx.actor.role, "settings.manage")) return <Forbidden />;
  const [settings, userList, templates] = await Promise.all([getOrgSettings(ctx), listUsers(ctx), listTemplates(ctx)]);

  return (
    <>
      <PageHeader title="Настройки" />
      <div className="space-y-8">
        <section className="space-y-3">
          <h2 className="font-semibold">Правила расчёта</h2>
          <SettingsForm
            initial={{
              name: settings.name,
              vatRateBp: settings.vatRateBp,
              deliveryAllocBase: settings.deliveryAllocBase,
              fleetRule: settings.fleetRule,
              fleetRateKop: settings.fleetRateKop,
              fuelPriceKopPerL: settings.fuelPriceKopPerL,
              driverHourKop: settings.driverHourKop,
              windowBufferMin: settings.windowBufferMin,
            }}
          />
        </section>

        <section className="space-y-3">
          <h2 className="font-semibold">Пользователи</h2>
          <Card className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  {["Имя", "Почта", "Роль", "Состояние", ""].map((h) => (
                    <th key={h} className={thClass}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody data-testid="user-list">
                {userList.map((u) => (
                  <tr key={u.id}>
                    <td className={tdClass}>{u.name}</td>
                    <td className={tdClass}>{u.email}</td>
                    <td className={tdClass}>{ROLE_LABELS[u.role]}</td>
                    <td className={tdClass}>{u.active ? <Badge tone="green">работает</Badge> : <Badge>отключён</Badge>}</td>
                    <td className={`${tdClass} text-right`}>
                      <UserActiveButton userId={u.id} active={u.active} self={ctx.actor.kind === "user" && ctx.actor.userId === u.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <CreateUserForm />
        </section>

        <section className="space-y-3">
          <h2 className="font-semibold">Шаблоны импорта</h2>
          <Card className="p-4">
            {templates.length === 0 ? (
              <p className="text-gray-500">Шаблонов нет. Их создают на странице «Импорт» по файлу-образцу.</p>
            ) : (
              <ul className="list-disc pl-5">
                {templates.map((t) => (
                  <li key={t.id}>{t.name}</li>
                ))}
              </ul>
            )}
          </Card>
        </section>
      </div>
    </>
  );
}
