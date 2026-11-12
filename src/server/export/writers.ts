import ExcelJS from "exceljs";
import { stringify } from "csv-stringify/sync";
import type { Cell, Column, Table } from "./datasets";

const BOM = "﻿";

/** Numbers for a Russian spreadsheet: decimal comma. */
function csvCell(value: Cell, kind: Column["kind"]): string {
  if (value === null) return "";
  if (typeof value === "number") return (kind === "money" ? value.toFixed(2) : String(value)).replace(".", ",");
  // Text that starts like a formula is shown as text, not run, when the file is opened in a spreadsheet.
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** UTF-8 with a byte order mark and semicolons, so it opens correctly in Excel. */
export function toCsv(table: Table): Buffer {
  const header = table.columns.map((c) => c.header);
  const body = table.rows.map((row) => table.columns.map((c) => csvCell(row[c.key] ?? null, c.kind)));
  return Buffer.from(BOM + stringify([header, ...body], { delimiter: ";", record_delimiter: "\r\n" }), "utf8");
}

export async function toXlsx(table: Table, sheetName: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName.slice(0, 31));
  sheet.columns = table.columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: Math.min(40, Math.max(12, c.header.length + 2)),
    style: c.kind === "money" ? { numFmt: "#,##0.00" } : {},
  }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  for (const row of table.rows) sheet.addRow(Object.fromEntries(table.columns.map((c) => [c.key, row[c.key] ?? null])));
  if (table.columns.length > 0) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: table.columns.length } };
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
