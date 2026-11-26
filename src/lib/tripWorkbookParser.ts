// Импорт на Excel файл „справка за изразходено гориво“ (един лист на месец, напр. "10.2026")
// Структура на листа:
//   D5 марка/модел, D7 рег.№, D8 вид гориво, D9 разходна норма
//   D13 остатък от предходен период, H14 километраж към 1-во число
//   редове 14.. : A дата, B шофьор, C изминати км, E заредено л,
//                 F =SUM(Cn*НОРМА/100) (нормата за деня е във формулата), G остатък
//
// Вход: листове с функция за четене на клетка ({v: стойност, f: формула}), напр. от SheetJS
//   XLSX.read(buf, { cellFormula: true }) -> ws["F14"] = { v: 8.4, f: "SUM(C14*7/100)" }

import { normalizePlate } from "./lukoilParser.ts";

export type CellGetter = (addr: string) => { v?: unknown; f?: string } | undefined;

export interface TripDayImport {
  day: string;          // YYYY-MM-DD
  driver: string;
  km: number | null;
  norm: number | null;  // нормата за деня от формулата
  refueled: number | null;
}

export interface TripMonthImport {
  sheet: string;
  month: string;        // YYYY-MM
  plate: string;
  plate_raw: string;
  model: string | null;
  fuel: string | null;
  default_norm: number | null;
  odometer_start: number | null;
  opening: number;
  days: TripDayImport[];
  km: number;
  refueled: number;
  consumed: number;
  closing: number;
  file_closing: number | null;
  warnings: string[];
}

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const pad = (n: number) => String(n).padStart(2, "0");

/** Норма от формула като "SUM(C14*6.5/100)" или "=C14*7/100" */
export function normFromFormula(f: string | undefined): number | null {
  if (!f) return null;
  const m = f.match(/\*\s*([\d]+(?:[.,]\d+)?)\s*\/\s*100/);
  return m ? Number(m[1].replace(",", ".")) : null;
}

export function parseTripSheet(name: string, cell: CellGetter): TripMonthImport | null {
  const m = name.match(/(\d{1,2})\s*[./-]\s*(\d{4})/);
  if (!m) return null;
  const mo = Number(m[1]);
  const yr = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const month = `${yr}-${pad(mo)}`;
  const nDays = new Date(yr, mo, 0).getDate();

  const plateRaw = str(cell("D7")?.v);
  const defaultNorm = num(cell("D9")?.v);
  const opening = num(cell("D13")?.v) ?? 0;
  const warnings: string[] = [];
  if (!plateRaw) warnings.push("няма рег. № в D7");

  const days: TripDayImport[] = [];
  let rest = opening, km = 0, ref = 0, cons = 0;
  for (let i = 0; i < nDays; i++) {
    const r = 14 + i;
    const k = num(cell(`C${r}`)?.v);
    const e = num(cell(`E${r}`)?.v);
    const n = normFromFormula(cell(`F${r}`)?.f) ?? defaultNorm;
    const driver = str(cell(`B${r}`)?.v);
    const c = ((k ?? 0) * (n ?? 0)) / 100;
    rest += (e ?? 0) - c;
    km += k ?? 0;
    ref += e ?? 0;
    cons += c;
    if (k || e) days.push({ day: `${month}-${pad(i + 1)}`, driver, km: k, norm: n, refueled: e });
  }
  const fileClosing = num(cell(`G${13 + nDays}`)?.v);
  if (fileClosing !== null && Math.abs(fileClosing - rest) > 0.01)
    warnings.push(`остатъкът не съвпада с файла (${r3(fileClosing)} л)`);
  if (rest < -0.001) warnings.push("отрицателен остатък");

  return {
    sheet: name, month, plate: normalizePlate(plateRaw), plate_raw: plateRaw,
    model: str(cell("D5")?.v) || null, fuel: str(cell("D8")?.v) || null, default_norm: defaultNorm,
    odometer_start: num(cell("H14")?.v), opening: r3(opening), days,
    km: r3(km), refueled: r3(ref), consumed: r3(cons), closing: r3(rest), file_closing: fileClosing, warnings,
  };
}

/** Всички месечни листове + проверка на връзката между месеците */
export function parseTripWorkbook(sheets: { name: string; cell: CellGetter }[]): TripMonthImport[] {
  const months = sheets
    .map((s) => parseTripSheet(s.name, s.cell))
    .filter((x): x is TripMonthImport => x !== null)
    .sort((a, b) => a.month.localeCompare(b.month));
  for (let i = 1; i < months.length; i++) {
    const p = months[i - 1], c = months[i];
    if (Math.abs(p.closing - c.opening) > 0.01)
      c.warnings.push(`началният остатък (${c.opening} л) ≠ крайния от ${p.month} (${p.closing} л)`);
    if (p.odometer_start !== null && c.odometer_start !== null) {
      const gap = c.odometer_start - (p.odometer_start + p.km);
      if (Math.abs(gap) > 0.5) p.warnings.push(`километражът не се връзва: ${gap > 0 ? "липсват" : "в повече"} ${Math.abs(Math.round(gap))} км спрямо ${c.month}`);
    }
    if (p.plate && c.plate && p.plate !== c.plate) c.warnings.push(`друг рег. № (${c.plate_raw})`);
  }
  return months;
}
