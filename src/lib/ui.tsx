import type { ReactNode } from "react";
import * as XLSX from "xlsx";

const pad = (n: number) => String(n).padStart(2, "0");

/** Число във формат 1 234,56 */
export function fmt(n: number | string | null | undefined, digits = 2): string {
  if (n === null || n === undefined || n === "") return "";
  const v = Number(n);
  if (Number.isNaN(v)) return String(n);
  return v.toLocaleString("bg-BG", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 2026-10-07 17:22:00 -> 07.10.2026 17:22 */
export function fmtTs(ts: string | null | undefined): string {
  if (!ts) return "";
  const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}` : ts;
}

/** Миналият месец като YYYY-MM */
export function prevMonth(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** [начало, начало на следващия месец) като 'YYYY-MM-DD' */
export function monthRange(ym: string): [string, string] {
  const [y, m] = ym.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
  return [`${ym}-01`, `${next}-01`];
}

/** Текст от поле -> число или null (приема и запетая) */
export function toNum(v: string): number | null {
  const s = v.trim().replace(/\s/g, "").replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function Notice({ kind, children }: { kind: "ok" | "err" | "info" | "warn"; children: ReactNode }) {
  return <div className={`notice notice-${kind}`}>{children}</div>;
}

export function downloadXlsx(rows: Record<string, unknown>[], sheetName: string, fileName: string) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  XLSX.writeFile(wb, fileName);
}

/** Чете първия лист на Excel файл като масив от редове */
export async function readSheetRows(file: File): Promise<unknown[][]> {
  const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
}

export function errText(e: unknown): string {
  if (!e) return "";
  if (e instanceof Error) return e.message;
  const o = e as { message?: string; details?: string; hint?: string };
  return [o.message, o.details, o.hint].filter(Boolean).join(" | ") || JSON.stringify(e);
}
