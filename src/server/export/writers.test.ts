import { parse } from "csv-parse/sync";
import { describe, expect, it } from "vitest";
import { toCsv } from "./writers";

describe("toCsv", () => {
  it("defuses text that a spreadsheet would run as a formula", () => {
    const table = {
      columns: [{ key: "name", header: "Имя", kind: "text" as const }],
      rows: [{ name: '=HYPERLINK("http://x","click")' }, { name: "+1" }, { name: "-1+1" }, { name: "@SUM(1)" }, { name: "\tx" }, { name: "Обычное" }],
    };
    const rows = parse(toCsv(table).toString("utf8").replace(/^﻿/, ""), { delimiter: ";" }) as string[][];
    const cells = rows.slice(1).map((r) => r[0]);
    expect(cells.slice(0, 5).every((c) => c.startsWith("'"))).toBe(true);
    expect(cells[5]).toBe("Обычное");
  });

  it("keeps negative numbers as numbers", () => {
    const table = { columns: [{ key: "n", header: "Сумма", kind: "money" as const }], rows: [{ n: -12.5 }] };
    const rows = parse(toCsv(table).toString("utf8").replace(/^﻿/, ""), { delimiter: ";" }) as string[][];
    expect(rows[1][0]).toBe("-12,50");
  });
});
