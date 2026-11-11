import Link from "next/link";
import { Forbidden } from "@/components/Forbidden";
import { PageHeader } from "@/components/ui";
import { can } from "@/domain/permissions";
import { requireCtx } from "@/server/auth/requireCtx";
import { TemplateEditor } from "./TemplateEditor";

export default async function NewTemplatePage() {
  const ctx = await requireCtx();
  if (!can(ctx.actor.role, "settings.manage")) return <Forbidden />;
  return (
    <>
      <PageHeader title="Новый шаблон импорта">
        <Link href="/import" className="text-blue-700 hover:underline">
          К импорту
        </Link>
      </PageHeader>
      <TemplateEditor />
    </>
  );
}
