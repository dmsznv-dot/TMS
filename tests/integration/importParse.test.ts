import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { parseTable } from "@/server/import/parse";
import { expectCode } from "../helpers/expectCode";

/** Encodes Russian text as Windows-1251, the usual encoding of 1C exports. */
function cp1251(text: string): Buffer {
  return Buffer.from(
    [...text].map((ch) => {
      const code = ch.codePointAt(0)!;
      if (code < 0x80) return code;
      if (code >= 0x410 && code <= 0x44f) return code - 0x350;
      if (ch === "Ё") return 0xa8;
      if (ch === "ё") return 0xb8;
      if (ch === "№") return 0xb9;
      throw new Error(`no cp1251 mapping for ${ch}`);
    }),
  );
}

async function xlsx(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("parseTable: CSV", () => {
  it("reads Windows-1251 with semicolons", async () => {
    const bytes = cp1251("Номер заказа;Точка;Количество\r\nЗ-1001;Склад №1;1 234,5\r\n");
    const { sheets } = await parseTable(bytes, "orders.csv");
    expect(sheets).toHaveLength(1);
    expect(sheets[0].headers).toEqual(["Номер заказа", "Точка", "Количество"]);
    expect(sheets[0].rows).toEqual([{ "Номер заказа": "З-1001", "Точка": "Склад №1", "Количество": "1 234,5" }]);
  });

  it("reads UTF-8 with a byte order mark and commas", async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Номер заказа,Точка\nЗ-1,RC-1\n", "utf8")]);
    const { sheets } = await parseTable(bytes, "orders.csv");
    expect(sheets[0].headers).toEqual(["Номер заказа", "Точка"]);
    expect(sheets[0].rows).toEqual([{ "Номер заказа": "З-1", "Точка": "RC-1" }]);
  });

  it("keeps quoted values with the delimiter inside", async () => {
    const { sheets } = await parseTable(Buffer.from('Товар;Количество\n"Вода; 0,5 л";3\n', "utf8"), "a.csv");
    expect(sheets[0].rows[0]).toEqual({ "Товар": "Вода; 0,5 л", "Количество": "3" });
  });

  it("skips empty lines and tolerates short rows", async () => {
    const { sheets } = await parseTable(Buffer.from("A;B;C\n1;2\n\n4;5;6\n", "utf8"), "a.csv");
    expect(sheets[0].rows).toEqual([
      { A: "1", B: "2" },
      { A: "4", B: "5", C: "6" },
    ]);
  });
});

describe("parseTable: XLSX", () => {
  it("returns sheets with headers and typed cells", async () => {
    const bytes = await xlsx((wb) => {
      const ws = wb.addWorksheet("Заказы");
      ws.addRow(["Номер заказа", "Окно с", "Количество"]);
      ws.addRow(["З-1001", new Date(Date.UTC(2026, 10, 12, 9, 0)), 10.5]);
      ws.addRow([]);
      ws.addRow(["З-1002", "12.11.2026 10:00", 3]);
      wb.addWorksheet("Пустой");
    });
    const { sheets } = await parseTable(bytes, "orders.xlsx");

    expect(sheets.map((s) => s.name)).toEqual(["Заказы", "Пустой"]);
    expect(sheets[0].headers).toEqual(["Номер заказа", "Окно с", "Количество"]);
    expect(sheets[0].rows).toHaveLength(2);
    expect(sheets[0].rows[0]["Номер заказа"]).toBe("З-1001");
    expect(sheets[0].rows[0]["Окно с"]).toEqual(new Date(Date.UTC(2026, 10, 12, 9, 0)));
    expect(sheets[0].rows[0]["Количество"]).toBe(10.5);
    expect(sheets[1].rows).toEqual([]);
  });

  it("uses the computed value of a formula cell", async () => {
    const bytes = await xlsx((wb) => {
      const ws = wb.addWorksheet("S");
      ws.addRow(["Количество"]);
      ws.addRow([{ formula: "2+3", result: 5 }]);
    });
    const { sheets } = await parseTable(bytes, "f.xlsx");
    expect(sheets[0].rows[0]["Количество"]).toBe(5);
  });
});

describe("parseTable: other input", () => {
  it("rejects an unsupported extension", async () => {
    await expectCode(parseTable(Buffer.from("x"), "orders.pdf"), "unsupported_file");
  });

  it("rejects a file that is not a workbook", async () => {
    await expectCode(parseTable(Buffer.from("not a zip"), "orders.xlsx"), "unreadable_file");
  });

  it("rejects an empty file", async () => {
    await expectCode(parseTable(Buffer.alloc(0), "orders.csv"), "empty_file");
  });
});
