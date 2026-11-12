import { parse as parseCsv } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { DomainError } from "@/domain/errors";

export type ParsedSheet = {
  name: string;
  headers: string[];
  /** One object per data row, keyed by header. Blank cells are omitted. */
  rows: Record<string, unknown>[];
};

export type ParsedTable = { sheets: ParsedSheet[] };

/** UTF-8 when the bytes are valid UTF-8, otherwise Windows-1251 (typical for 1C exports). */
function decodeText(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1251").decode(bytes);
  }
}

function detectDelimiter(firstLine: string): string {
  const counts = [";", ",", "\t"].map((d) => [d, firstLine.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ";";
}

function parseCsvBytes(bytes: Buffer): ParsedTable {
  const text = decodeText(bytes).replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  let records: string[][];
  try {
    records = parseCsv(text, {
      delimiter: detectDelimiter(firstLine),
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    }) as string[][];
  } catch (e) {
    throw new DomainError("unreadable_file", `Файл не удалось разобрать: ${(e as Error).message}`);
  }
  if (records.length === 0) throw new DomainError("empty_file", "Файл пуст");

  const headers = records[0].map((h) => h.trim());
  const rows = records.slice(1).flatMap((record) => {
    const row: Record<string, unknown> = {};
    headers.forEach((header, i) => {
      const value = record[i];
      if (header && value != null && value !== "") row[header] = value;
    });
    return Object.keys(row).length > 0 ? [row] : [];
  });
  return { sheets: [{ name: "CSV", headers: headers.filter(Boolean), rows }] };
}

/** The plain value of a spreadsheet cell: formulas give their result, rich text its characters. */
function cellValue(value: ExcelJS.CellValue): unknown {
  if (value == null) return undefined;
  if (value instanceof Date || typeof value !== "object") return value;
  if ("result" in value) return cellValue(value.result as ExcelJS.CellValue);
  if ("richText" in value) return value.richText.map((part) => part.text).join("");
  if ("text" in value) return value.text;
  if ("error" in value) return undefined;
  return undefined;
}

async function parseXlsxBytes(bytes: Buffer): Promise<ParsedTable> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    throw new DomainError("unreadable_file", "Файл не является книгой Excel (.xlsx)");
  }

  const sheets: ParsedSheet[] = workbook.worksheets.map((ws) => {
    const headerByColumn = new Map<number, string>();
    ws.getRow(1).eachCell((cell, col) => {
      const header = String(cellValue(cell.value) ?? "").trim();
      if (header) headerByColumn.set(col, header);
    });

    const rows: Record<string, unknown>[] = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const record: Record<string, unknown> = {};
      row.eachCell((cell, col) => {
        const header = headerByColumn.get(col);
        const value = cellValue(cell.value);
        if (!header || value === undefined) return;
        if (typeof value === "string" && value.trim() === "") return;
        record[header] = typeof value === "string" ? value.trim() : value;
      });
      if (Object.keys(record).length > 0) rows.push(record);
    });
    return { name: ws.name, headers: [...headerByColumn.values()], rows };
  });
  return { sheets };
}

/** Reads an uploaded XLSX or CSV file into sheets of rows keyed by header. */
export async function parseTable(bytes: Buffer, filename: string): Promise<ParsedTable> {
  const extension = filename.toLowerCase().split(".").pop();
  if (extension !== "xlsx" && extension !== "csv" && extension !== "txt") {
    throw new DomainError("unsupported_file", "Поддерживаются файлы .xlsx и .csv");
  }
  if (bytes.length === 0) throw new DomainError("empty_file", "Файл пуст");
  return extension === "xlsx" ? parseXlsxBytes(bytes) : parseCsvBytes(bytes);
}
