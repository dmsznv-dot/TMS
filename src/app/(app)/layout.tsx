import { logoutAction } from "@/app/actions/auth";
import { Nav, type NavItem } from "@/components/Nav";
import { buttonClass } from "@/components/ui";
import { can, ROLE_LABELS, type Action } from "@/domain/permissions";
import { currentUser, requireCtx } from "@/server/auth/requireCtx";

/** Navigation entries with the permission needed to see each one. */
const NAV: (NavItem & { needs: Action })[] = [
  { href: "/planning", label: "Планирование", needs: "trips.read" },
  { href: "/trips", label: "Рейсы", needs: "trips.read" },
  { href: "/triage", label: "Разобрать", needs: "trips.read" },
  { href: "/money", label: "Счета и оплаты", needs: "money.read" },
  { href: "/import", label: "Импорт", needs: "planning.write" },
  { href: "/export", label: "Выгрузки", needs: "export.run" },
  { href: "/refs", label: "Справочники", needs: "refs.read" },
  { href: "/settings", label: "Настройки", needs: "settings.manage" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireCtx();
  const user = await currentUser(ctx);
  const items = NAV.filter((item) => can(user.role, item.needs)).map(({ href, label }) => ({ href, label }));

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-gray-200 bg-white p-3">
        <div className="mb-4 px-3 pt-1 text-sm font-semibold leading-tight">Поставки и экономика рейсов</div>
        <Nav items={items} />
        <div className="mt-auto border-t border-gray-100 px-3 pt-3">
          <div className="font-medium">{user.name}</div>
          <div className="mb-2 text-xs text-gray-500">{ROLE_LABELS[user.role]}</div>
          <form action={logoutAction}>
            <button type="submit" className={buttonClass("secondary")}>
              Выйти
            </button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-6">{children}</main>
    </div>
  );
}
