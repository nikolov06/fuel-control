// Парсер за "Справка за включени покупки във фактура" от Лукойл (.xlsx)
//
// Вход: редовете на листа като масив от масиви, напр. от SheetJS:
//   const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
//   const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
//   const result = parseLukoilRows(rows);
//
// Структура на файла: блокове по фирма →
//   [Фирма] / [Справка ... фактура №: X / ДД.ММ.ГГГГ г.] / [заглавен ред] / редове / [междинни сборове]

export type FuelCategory = "Дизел" | "Бензин" | "AdBlue" | "Друго";

export interface LukoilRow {
  company: string | null;
  invoice_no: string | null;
  invoice_date: string | null; // YYYY-MM-DD
  plate_raw: string;
  plate: string;               // нормализиран
  card: string | null;
  ts: string;                  // YYYY-MM-DD HH:MM:SS (местно време)
  receipt_no: string | null;
  product: string;
  fuel_category: FuelCategory;
  unit_price: number | null;
  liters: number;
  amount: number | null;
  station: string | null;
  source_row: number;          // ред в Excel (за справка при грешка)
}

export interface ParseResult {
  rows: LukoilRow[];
  skipped: { row: number; reason: string; values: unknown[] }[];
  invoiceNo: string | null;
  invoiceDate: string | null;
  companies: string[];
}

const HEADER_KEYS: Record<string, keyof typeof COL_DEFAULT> = {
  "автомобил": "plate", "карта": "card", "дата и час": "ts", "номер на бон": "receipt",
  "стока": "product", "ед. цена": "price", "количество": "qty", "стойност": "amount",
  "бензиностанция": "station",
};
const COL_DEFAULT = { plate: 0, card: 1, ts: 2, receipt: 3, product: 4, price: 5, qty: 6, amount: 7, station: 8 };

export function normalizePlate(p: string | null | undefined): string {
  if (!p) return "";
  const map: Record<string, string> = {
    А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", У: "Y", Х: "X",
  };
  return p.toUpperCase().replace(/[АВЕКМНОРСТУХ]/g, (c) => map[c]).replace(/[\s-]/g, "");
}

export function categorize(product: string): FuelCategory {
  const p = product.toLowerCase();
  if (p.includes("adblue")) return "AdBlue";
  if (p.includes("дизел") || p.includes("diesel") || /^(дт|д|dt|d)$/.test(p.trim())) return "Дизел";
  if (p.includes("бензин") || /(^|[^a-zа-я])(a|а)\s?-?\s?(95|98|100)/.test(p) || /ecto\s?100/.test(p)
      || /^(б|95|98|100)$/.test(p.trim())) return "Бензин";
  return "Друго";
}

const pad = (n: number) => String(n).padStart(2, "0");

function toTs(v: unknown): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) {
    // SheetJS с cellDates дава локална дата
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())} ${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}`;
  }
  if (typeof v === "number" && v > 30000 && v < 80000) {
    // Excel сериен номер на дата
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }
  if (typeof v === "string") {
    const m = v.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])} ${pad(+(m[4] ?? 0))}:${m[5] ?? "00"}:${m[6] ?? "00"}`;
  }
  return null;
}

function toNum(v: unknown): number | null {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/\s/g, "").replace(",", "."));
    return isFinite(n) && v.trim() !== "" ? n : null;
  }
  return null;
}

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

export function parseLukoilRows(sheet: unknown[][]): ParseResult {
  const rows: LukoilRow[] = [];
  const skipped: ParseResult["skipped"] = [];
  const companies = new Set<string>();
  let col = { ...COL_DEFAULT };
  let company: string | null = null;
  let invoiceNo: string | null = null;
  let invoiceDate: string | null = null;
  let lastNonEmptySingle: string | null = null;

  sheet.forEach((r, i) => {
    const excelRow = i + 1;
    const cells = (r ?? []).map((c) => (typeof c === "string" ? c.trim() : c));
    const nonEmpty = cells.filter((c) => c !== null && c !== undefined && c !== "");
    if (nonEmpty.length === 0) return;

    const first = str(cells[0]);

    // Ред с фактура -> предишният самостоятелен ред е фирмата
    const inv = first?.match(/фактура\s*№\s*:?\s*(\S+)\s*\/\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/i);
    if (inv) {
      invoiceNo = inv[1];
      invoiceDate = `${inv[4]}-${pad(+inv[3])}-${pad(+inv[2])}`;
      company = lastNonEmptySingle;
      if (company) companies.add(company);
      return;
    }

    // Заглавен ред -> позиции на колоните
    if (first && first.toLowerCase() === "автомобил") {
      col = { ...COL_DEFAULT };
      cells.forEach((c, idx) => {
        const k = HEADER_KEYS[String(c ?? "").trim().toLowerCase()];
        if (k) col[k] = idx;
      });
      return;
    }

    // Самостоятелен текст в първата клетка (кандидат за фирма)
    if (nonEmpty.length === 1 && first) {
      lastNonEmptySingle = first;
      return;
    }

    // Ред с данни
    const ts = toTs(cells[col.ts]);
    const qty = toNum(cells[col.qty]);
    const plateRaw = str(cells[col.plate]);
    if (!ts || qty === null || !plateRaw) {
      // Междинните сборове (само количество/стойност) се пропускат тихо
      if (!plateRaw && !ts) return;
      skipped.push({ row: excelRow, reason: !ts ? "неразпозната дата" : !plateRaw ? "липсва автомобил" : "липсва количество", values: cells });
      return;
    }
    const product = str(cells[col.product]) ?? "";
    rows.push({
      company, invoice_no: invoiceNo, invoice_date: invoiceDate,
      plate_raw: plateRaw, plate: normalizePlate(plateRaw),
      card: str(cells[col.card]),
      ts,
      receipt_no: str(cells[col.receipt]),
      product,
      fuel_category: categorize(product),
      unit_price: toNum(cells[col.price]),
      liters: qty,
      amount: toNum(cells[col.amount]),
      station: str(cells[col.station]),
      source_row: excelRow,
    });
  });

  return { rows, skipped, invoiceNo, invoiceDate, companies: [...companies] };
}

// Обобщение за екрана "Преглед преди импорт"
export function summarize(result: ParseResult) {
  const byCat = new Map<string, { liters: number; amount: number; count: number }>();
  for (const r of result.rows) {
    const s = byCat.get(r.fuel_category) ?? { liters: 0, amount: 0, count: 0 };
    s.liters += r.liters; s.amount += r.amount ?? 0; s.count++;
    byCat.set(r.fuel_category, s);
  }
  return {
    rows: result.rows.length,
    vehicles: new Set(result.rows.map((r) => r.plate)).size,
    companies: result.companies.length,
    byCategory: Object.fromEntries([...byCat].map(([k, v]) => [k, {
      ...v, liters: Math.round(v.liters * 100) / 100, amount: Math.round(v.amount * 100) / 100,
    }])),
    nonFuel: result.rows.filter((r) => r.fuel_category === "Друго"),
    skipped: result.skipped.length,
  };
}
