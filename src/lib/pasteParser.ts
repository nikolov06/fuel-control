// Парсер за ръчни зареждания (локални бензиностанции), поставени с Ctrl+V от Excel.
// Excel копира като текст с табулации между колоните и нов ред между редовете.
//
// Колоните се разпознават по заглавен ред (в произволен ред и с различни имена).
// Ако няма заглавен ред, се ползва редът от шаблона:
//   Рег. номер | Дата | Час | Гориво | Литри | Стойност | Бензиностанция | Бон
//
// Използване:
//   const res = parsePasted(text, { station: "Петрол Генерал Тошево", fuelDefault: "Дизел", year: 2026 });
//   const checked = validateAgainst(res.rows, new Set(vehicles.map(v => v.plate)));

import { normalizePlate, categorize, type FuelCategory } from "./lukoilParser.ts";

export interface PastedRow {
  line: number;                // ред в поставения текст (1 = първи)
  plate_raw: string;
  plate: string;
  ts: string | null;           // YYYY-MM-DD HH:MM:SS
  time_missing: boolean;       // нямаше час -> 12:00
  product: string;
  fuel_category: FuelCategory;
  liters: number | null;
  unit_price: number | null;
  amount: number | null;
  station: string | null;
  receipt_no: string | null;
  card: string | null;
  company: string | null;
  invoice_no: string | null;
  invoice_date: string | null;
  errors: string[];            // блокиращи: редът не може да се импортира
  warnings: string[];          // за внимание, но може да се импортира
}

export interface PasteOptions {
  station?: string;            // по подразбиране, ако няма колона
  fuelDefault?: FuelCategory;  // по подразбиране, ако няма колона за гориво
  year?: number;               // ако датите са без година (15.10)
}

export interface PasteResult {
  rows: PastedRow[];
  headerDetected: boolean;
  columns: Partial<Record<ColKey, number>>;
}

type ColKey = "plate" | "date" | "time" | "fuel" | "liters" | "price" | "amount" | "station" | "receipt" | "card";

const TEMPLATE_ORDER: ColKey[] = ["plate", "date", "time", "fuel", "liters", "amount", "station", "receipt"];

// Синоними на заглавията (сравнява се с малки букви, без точки и интервали в края)
const SYNONYMS: [ColKey, RegExp][] = [
  ["plate",   /^(рег\.?\s*(№|номер)?|рег номер|регистрационен номер|мпс|автомобил|кола|машина|номер на мпс|рег\.? №)$/],
  ["date",    /^(дата|дата и час|дата\/час)$/],
  ["time",    /^(час|време)$/],
  ["fuel",    /^(гориво|вид гориво|вид|стока|продукт)$/],
  ["liters",  /^(литри|л\.?|количество|к-во|кол\.?|кол-во|литра)$/],
  ["price",   /^(ед\.?\s*цена|цена|цена\/л|цена за литър)$/],
  ["amount",  /^(стойност|сума|общо|стойност лв\.?|стойност eur|стойност €)$/],
  ["station", /^(бензиностанция|станция|обект|бензиностанция\/обект)$/],
  ["receipt", /^(бон|номер на бон|№ бон|касов бон|бележка|документ|№)$/],
  ["card",    /^(карта|номер на карта)$/],
];

const pad = (n: number) => String(n).padStart(2, "0");

function splitLine(line: string): string[] {
  if (line.includes("\t")) return line.split("\t");
  if (line.includes(";")) return line.split(";");
  return line.split(/\s{2,}/); // последен вариант: 2+ интервала
}

function headerKey(cell: string): ColKey | null {
  const c = cell.trim().toLowerCase().replace(/[:.]+$/, "").replace(/\s+/g, " ");
  if (!c) return null;
  for (const [k, re] of SYNONYMS) if (re.test(c)) return k;
  return null;
}

export function parseNumber(v: string | undefined): number | null {
  if (v === undefined) return null;
  let s = v.trim().replace(/[^\d,.\-\s]/g, "").replace(/\s/g, ""); // маха "л", "лв", "€"
  if (!s) return null;
  // "1.234,56" -> 1234.56 ; "1,234.56" -> 1234.56 ; "123,4" -> 123.4
  if (s.includes(",") && s.includes(".")) {
    s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else {
    s = s.replace(",", ".");
  }
  const n = Number(s);
  return isFinite(n) ? n : null;
}

function parseDate(v: string | undefined, year?: number): { date: string; time: string | null } | null {
  if (!v) return null;
  const s = v.trim();
  // 15.10.2026 / 15.10.26 / 15/10/2026 / 15-10-2026 / 15.10 (+ по избор час)
  let m = s.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\s*(?:г\.?)?\s*(?:(\d{1,2})[:.](\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    let y = m[3] ? +m[3] : year;
    if (!y) return null;
    if (y < 100) y += 2000;
    const d = +m[1], mo = +m[2];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1) return null; // 31.11 и т.н.
    const time = m[4] ? `${pad(+m[4])}:${m[5]}:${m[6] ?? "00"}` : null;
    return { date: `${y}-${pad(mo)}-${pad(d)}`, time };
  }
  // ISO: 2026-10-15 [10:30]
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: m[4] ? `${pad(+m[4])}:${m[5]}:${m[6] ?? "00"}` : null };
  return null;
}

function parseTime(v: string | undefined): string | null {
  if (!v) return null;
  const m = v.trim().match(/^(\d{1,2})[:.](\d{2})(?::(\d{2}))?$/);
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return `${pad(+m[1])}:${m[2]}:${m[3] ?? "00"}`;
}

export function parsePasted(text: string, opt: PasteOptions = {}): PasteResult {
  const lines = text.replace(/\r/g, "").split("\n");
  const table = lines.map((l, i) => ({ line: i + 1, cells: splitLine(l).map((c) => c.trim()) }))
    .filter((r) => r.cells.some((c) => c !== ""));

  let columns: Partial<Record<ColKey, number>> = {};
  let headerDetected = false;
  if (table.length) {
    const keys = table[0].cells.map(headerKey);
    if (keys.filter(Boolean).length >= 2) {
      headerDetected = true;
      keys.forEach((k, i) => { if (k && columns[k] === undefined) columns[k] = i; });
      table.shift();
    }
  }
  if (!headerDetected) TEMPLATE_ORDER.forEach((k, i) => (columns[k] = i));

  const get = (cells: string[], k: ColKey) => (columns[k] !== undefined ? cells[columns[k]!] : undefined);

  const rows: PastedRow[] = table.map(({ line, cells }) => {
    const errors: string[] = [];
    const warnings: string[] = [];

    const plateRaw = (get(cells, "plate") ?? "").trim();
    const plate = normalizePlate(plateRaw);
    if (!plate) errors.push("липсва рег. номер");
    else if (!/^[A-Z]{1,2}\d{4}[A-Z]{1,2}$/.test(plate)) warnings.push("необичаен формат на рег. номер");

    const d = parseDate(get(cells, "date"), opt.year);
    let time = d?.time ?? parseTime(get(cells, "time"));
    const timeMissing = !!d && !time;
    if (!d) errors.push(get(cells, "date") ? "неразпозната дата" : "липсва дата");
    if (timeMissing) { time = "12:00:00"; warnings.push("няма час — записва се 12:00"); }
    const ts = d ? `${d.date} ${time}` : null;

    const fuelText = (get(cells, "fuel") ?? "").trim();
    let product = fuelText || opt.fuelDefault || "";
    let cat: FuelCategory = product ? categorize(product) : "Друго";
    if (!fuelText && opt.fuelDefault) cat = opt.fuelDefault;
    if (!product) errors.push("липсва вид гориво");
    else if (cat === "Друго") warnings.push(`„${product}“ не е разпознато като гориво — няма да влезе в разхода`);

    const liters = parseNumber(get(cells, "liters"));
    if (liters === null) errors.push("липсва количество");
    else if (liters <= 0) errors.push("количество ≤ 0");
    else if (liters > 1500) warnings.push("много голямо количество");

    let unitPrice = parseNumber(get(cells, "price"));
    const amount = parseNumber(get(cells, "amount"));
    if (unitPrice === null && amount !== null && liters) unitPrice = Math.round((amount / liters) * 1000) / 1000;

    const station = (get(cells, "station") ?? "").trim() || opt.station || null;
    if (!station) warnings.push("няма бензиностанция");

    return {
      line, plate_raw: plateRaw, plate, ts, time_missing: timeMissing,
      product, fuel_category: cat, liters, unit_price: unitPrice, amount,
      station, receipt_no: (get(cells, "receipt") ?? "").trim() || null,
      card: (get(cells, "card") ?? "").trim() || null,
      company: null, invoice_no: null, invoice_date: null,
      errors, warnings,
    };
  });

  // Дубликати в самото поставяне (същата машина, час и литри)
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (!r.ts || r.liters === null) continue;
    const k = `${r.plate}|${r.ts}|${r.liters}`;
    if (seen.has(k)) r.warnings.push(`повтаря ред ${seen.get(k)}`);
    else seen.set(k, r.line);
  }

  return { rows, headerDetected, columns };
}

// Проверка спрямо номенклатурата: непознатите машини се маркират, но не блокират
export function validateAgainst(rows: PastedRow[], knownPlates: Set<string>, fuelByPlate?: Map<string, string>) {
  for (const r of rows) {
    if (r.plate && !knownPlates.has(r.plate)) r.warnings.push("машината не е в базата — няма да влезе в сметката");
    const ft = fuelByPlate?.get(r.plate);
    if (ft && r.fuel_category !== "Друго" && r.fuel_category !== "AdBlue" && ft !== r.fuel_category)
      r.warnings.push(`машината е ${ft}, а е заредено ${r.fuel_category}`);
  }
  return rows;
}

// Само редовете без грешки, във формата за import_refuels
export function toImportRows(rows: PastedRow[]) {
  return rows.filter((r) => r.errors.length === 0).map(({ line, errors, warnings, time_missing, ...rest }) => rest);
}
