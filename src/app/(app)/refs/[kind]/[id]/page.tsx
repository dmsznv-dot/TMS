import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { isDomainError } from "@/domain/errors";
import { can } from "@/domain/permissions";
import { requireCtx } from "@/server/auth/requireCtx";
import { env } from "@/server/env";
import { isRefKind, REF_CONFIG } from "../../config";
import { EditRefForm } from "../../RefForms";

export default async function RefEditPage({ params }: { params: Promise<{ kind: string; id: string }> }) {
  const { kind, id } = await params;
  if (!isRefKind(kind)) notFound();
  const ctx = await requireCtx();
  if (!can(ctx.actor.role, "refs.write")) notFound();
  const config = REF_CONFIG[kind];

  const row = await config.get(ctx, id).catch((e: unknown) => {
    if (isDomainError(e) && e.code === "not_found") notFound();
    throw e;
  });
  const map = config.map ? { ...config.map, tileUrl: env.MAP_TILE_URL } : undefined;

  return (
    <>
      <PageHeader title={`${config.title}: изменение`}>
        <Link href={`/refs/${kind}`} className="text-blue-700 hover:underline">
          К списку
        </Link>
      </PageHeader>
      <EditRefForm kind={kind} id={id} fields={config.fields} map={map} initial={row} active={row.active} />
    </>
  );
}
