// Парсер за ръчния файл "Разпределение на горивото" (.xls/.xlsx), напр. 09.2026
// Блокове по фирма: заглавен ред [отдел/код | ФИРМА | Кол-во към дата | За изписване | Остатък],
// после редове: [отдел | "РЕГ.№ МАРКА МОДЕЛ" | кол-во | за изписване | остатък | бележка | бележка2]
//
// Вход: редове като масив от масиви (SheetJS sheet_to_json с header:1, raw:true).
// Остатъкът се смята като Кол-во − За изписване (в Excel е формула).

import { normalizePlate } from "./lukoilParser.ts";

export type VehicleStatus = "active" | "for_sale" | "stored" | "damaged" | "sold";

export interface AllocationRow {
  company: string;
  department: number | null;
  plate: string;
  plate_raw: string;
  model: string;
  qty_available: number;   // Кол-во към дата = начален остатък + заредено
  written_off: number;     // За изписване
  closing: number;         // Остатък
  note: string | null;
  status: VehicleStatus;
  source_row: number;
}

const PLATE_RE = /^\s*([A-ZА-Я]{1,2})\s?(\d{4}|\d{2}\s\d{2})\s?([A-ZА-Я]{1,2})(?=\s|$|-)/i;

export function guessStatus(note: string | null): VehicleStatus {
  const n = (note ?? "").toLowerCase();
  if (/продаден/.test(n)) return "sold";
  if (/за продажба|предстояща продажба/.test(n)) return "for_sale";
  if (/аварирал/.test(n)) return "damaged";
  if (/съхранява|съхранение|гарира|не се ползва/.test(n)) return "stored";
  return "active";
}

const num = (v: unknown): number => {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string") { const n = Number(v.replace(/\s/g, "").replace(",", ".")); return isFinite(n) ? n : 0; }
  return 0;
};
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function parseAllocationRows(sheet: unknown[][]) {
  const rows: AllocationRow[] = [];
  const skipped: { row: number; text: string }[] = [];
  let company: string | null = null;

  sheet.forEach((r, i) => {
    const c = r ?? [];
    const second = typeof c[1] === "string" ? c[1].trim() : "";
    const third = typeof c[2] === "string" ? c[2].trim().toLowerCase() : "";
    if (third.startsWith("кол-во")) { company = second.replace(/\s+/g, " "); return; }
    if (!company || !second) return;

    const m = second.match(PLATE_RE);
    if (!m) { skipped.push({ row: i + 1, text: second }); return; }

    const plateRaw = m[0].trim();
    const qty = num(c[2]);
    const wo = num(c[3]);
    const notes = [c[5], c[6]].filter((x) => x !== null && x !== undefined && String(x).trim() !== "")
      .map((x) => String(x).trim());
    const note = notes.join(" | ") || null;
    const dept = num(c[0]) || null;

    rows.push({
      company, department: dept, plate: normalizePlate(plateRaw), plate_raw: plateRaw,
      model: second.slice(m[0].length).replace(/^[\s-]+/, "").trim(),
      qty_available: r3(qty), written_off: r3(wo), closing: r3(qty - wo),
      note, status: guessStatus(note), source_row: i + 1,
    });
  });

  return { rows, skipped, companies: [...new Set(rows.map((r) => r.company))] };
}
