import { isDomainError } from "@/domain/errors";
import { getCtx } from "@/server/auth/requireCtx";
import { DATASETS, exportDataset, type Dataset } from "@/server/export";

/** GET /api/export?dataset=orders&format=xlsx — a file for the signed-in user. */
export async function GET(request: Request): Promise<Response> {
  const ctx = await getCtx();
  if (!ctx) return new Response("Требуется вход", { status: 401 });

  const params = new URL(request.url).searchParams;
  const dataset = params.get("dataset") ?? "";
  const format = params.get("format") ?? "";
  if (!(DATASETS as readonly string[]).includes(dataset) || (format !== "xlsx" && format !== "csv")) {
    return new Response("Неизвестный набор данных или формат", { status: 400 });
  }

  try {
    const file = await exportDataset(ctx, dataset as Dataset, format);
    return new Response(new Uint8Array(file.body), {
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": `attachment; filename="${file.filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    if (isDomainError(e)) return new Response(e.message, { status: e.code === "forbidden" ? 403 : 400 });
    console.error("Export failed", e instanceof Error ? e.message : e);
    return new Response("Не удалось сформировать файл", { status: 500 });
  }
}
