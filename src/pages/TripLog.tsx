import { useEffect, useMemo, useState } from "react";
import type { ClipboardEvent } from "react";
import { supabase } from "../lib/supabase";
import { Notice, errText, fmt, fmtTs, monthRange, prevMonth, toNum, downloadXlsx, readWorkbookSheets } from "../lib/ui";
import { parseTripWorkbook } from "../lib/tripWorkbookParser.ts";
import type { TripMonthImport } from "../lib/tripWorkbookParser.ts";

interface Veh {
  plate: string;
  model: string | null;
  company: string | null;
  norm_l_100km: number | null;
  has_gps: boolean;
  in_allocation: boolean;
  note: string | null;
}
interface DayRow {
  driver: string;
  km: string;
  norm: string;
}
interface RefuelLite {
  ts: string;
  liters: number;
  product: string | null;
  station: string | null;
  source: string | null;
}

// Шофьорът се пази в базата, но не се показва (колите са мениджърски)
const FIELDS: (keyof DayRow)[] = ["km", "norm"];
const WD = ["нд", "пн", "вт", "ср", "чт", "пт", "сб"];
const pad = (n: number) => String(n).padStart(2, "0");

function daysOf(ym: string): string[] {
  const [y, m] = ym.split("-").map(Number);
  const n = new Date(y, m, 0).getDate();
  return Array.from({ length: n }, (_, i) => `${ym}-${pad(i + 1)}`);
}
function shiftMonth(ym: string, d: number): string {
  const [y, m] = ym.split("-").map(Number);
  const dt = new Date(y, m - 1 + d, 1);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}`;
}
/** Дата от Excel: 01.10.2026, 1.10.26, 2026-10-01, 01.10.2026 г. -> YYYY-MM-DD */
function parseDay(s: string): string | null {
  const t = s.trim();
  let m = t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${y}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`;
  }
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
const isNumText = (s: string) => toNum(s) !== null;

export default function TripLog() {
  const [vehicles, setVehicles] = useState<Veh[]>([]);
  const [plate, setPlate] = useState("");
  const [month, setMonth] = useState(prevMonth());
  const [rows, setRows] = useState<Record<string, DayRow>>({});
  const [odoStart, setOdoStart] = useState("");
  const [opening, setOpening] = useState("");
  const [openingHint, setOpeningHint] = useState("");
  const [refuels, setRefuels] = useState<RefuelLite[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err" | "warn"; text: string } | null>(null);
  const [imp, setImp] = useState<TripMonthImport[] | null>(null);
  const [impFile, setImpFile] = useState("");
  const [impBusy, setImpBusy] = useState(false);
  const [impMsg, setImpMsg] = useState<{ kind: "ok" | "err" | "warn"; text: string } | null>(null);
  const [showImport, setShowImport] = useState(false);

  useEffect(() => {
    supabase
      .from("vehicles")
      .select("plate,model,company,norm_l_100km,has_gps,in_allocation,note")
      .then(({ data }) => {
        const v = ((data ?? []) as Veh[])
          .filter((x) => !x.has_gps || x.in_allocation)
          .sort((a, b) => Number(a.has_gps) - Number(b.has_gps) || a.plate.localeCompare(b.plate));
        setVehicles(v);
        const first = v.find((x) => !x.has_gps);
        if (first) setPlate((p) => p || first.plate);
      });
  }, []);

  const veh = vehicles.find((v) => v.plate === plate);
  const days = useMemo(() => daysOf(month), [month]);

  async function load() {
    if (!plate) return;
    setMsg(null);
    const [from, to] = monthRange(month);
    const prev = shiftMonth(month, -1);
    const [d, tm, pm, rf] = await Promise.all([
      supabase.from("trip_days").select("*").eq("plate", plate).gte("day", from).lt("day", to),
      supabase.from("trip_months").select("*").eq("plate", plate).eq("month", month),
      supabase.from("trip_months").select("*").eq("plate", plate).eq("month", prev),
      supabase.from("refuels").select("ts,liters,product,station,source,fuel_category").eq("plate", plate).gte("ts", from).lt("ts", to).order("ts"),
    ]);
    const err = d.error || tm.error || pm.error || rf.error;
    if (err) setMsg({ kind: "err", text: errText(err) });
    const map: Record<string, DayRow> = {};
    for (const r of (d.data ?? []) as { day: string; driver: string | null; km: number | null; norm: number | null }[])
      map[r.day] = { driver: r.driver ?? "", km: r.km == null ? "" : String(r.km), norm: r.norm == null ? "" : String(r.norm) };
    setRows(map);
    const cur = ((tm.data ?? []) as { odometer_start: number | null; opening_fuel: number | null }[])[0];
    const prv = ((pm.data ?? []) as { closing_fuel: number | null; odometer_start: number | null; km_total: number | null }[])[0];
    setOdoStart(cur?.odometer_start != null ? String(cur.odometer_start) : prv?.odometer_start != null ? String(Number(prv.odometer_start) + Number(prv.km_total ?? 0)) : "");
    setOpening(cur?.opening_fuel != null ? String(cur.opening_fuel) : prv?.closing_fuel != null ? String(Math.round(Number(prv.closing_fuel) * 1000) / 1000) : "");
    setOpeningHint(prv?.closing_fuel != null ? `остатък от ${prev}: ${fmt(prv.closing_fuel, 3)} л` : "няма записан предходен месец — въведи остатъка ръчно");
    setRefuels(((rf.data ?? []) as (RefuelLite & { fuel_category: string | null })[]).filter((r) => !["AdBlue", "Друго"].includes(r.fuel_category ?? "")));
    setDirty(false);
  }
  useEffect(() => {
    load();
  }, [plate, month]);

  function setCell(day: string, f: keyof DayRow, v: string) {
    setRows((p) => ({ ...p, [day]: { ...(p[day] ?? { driver: "", km: "", norm: "" }), [f]: v } }));
    setDirty(true);
  }

  // Поставяне от Excel в таблицата
  function onPaste(e: ClipboardEvent<HTMLInputElement>, dayIdx: number, field: keyof DayRow) {
    const text = e.clipboardData.getData("text/plain");
    if (!text.includes("\t") && !text.includes("\n")) return; // обикновена стойност -> стандартно поставяне
    e.preventDefault();
    const lines = text.replace(/\r/g, "").split("\n").filter((l, i, a) => l.trim() !== "" || i < a.length - 1).map((l) => l.split("\t"));
    const next = { ...rows };
    let filled = 0;
    let outside = 0;
    const dateMode = lines.some((c) => parseDay(c[0] ?? "") !== null);
    if (dateMode) {
      // Редове: Дата | Шофьор | Км | ... -> взимаме датата и първото число като км, шофьора игнорираме
      for (const c of lines) {
        const day = parseDay(c[0] ?? "");
        if (!day) continue;
        if (!day.startsWith(month)) {
          outside++;
          continue;
        }
        const rest = c.slice(1).map((x) => x.trim());
        const km = rest.find((x) => isNumText(x)) ?? "";
        const cur = next[day] ?? { driver: "", km: "", norm: "" };
        next[day] = { ...cur, km };
        filled++;
      }
    } else {
      // Позиционно: от текущата клетка надолу и надясно
      const startCol = FIELDS.indexOf(field);
      lines.forEach((c, i) => {
        const day = days[dayIdx + i];
        if (!day) return;
        const cur = { ...(next[day] ?? { driver: "", km: "", norm: "" }) };
        c.forEach((val, j) => {
          const f = FIELDS[startCol + j];
          if (f) cur[f] = val.trim();
        });
        next[day] = cur;
        filled++;
      });
    }
    setRows(next);
    setDirty(true);
    setMsg({
      kind: outside ? "warn" : "ok",
      text: `Поставени ${filled} реда.${outside ? ` ${outside} реда са от друг месец и са пропуснати.` : ""} Не забравяй „Запиши“.`,
    });
  }

  async function onImportFile(f: File | undefined) {
    setImp(null);
    setImpMsg(null);
    if (!f) return;
    setImpFile(f.name);
    try {
      const months = parseTripWorkbook(await readWorkbookSheets(f));
      if (!months.length) return setImpMsg({ kind: "err", text: "Не намерих месечни листове (имена като 10.2026)." });
      const p = months[months.length - 1].plate;
      if (!vehicles.some((v) => v.plate === p))
        setImpMsg({ kind: "err", text: `Колата ${p} я няма в „Машини“. Добави я първо там.` });
      else setPlate(p);
      setImp(months);
    } catch (e) {
      setImpMsg({ kind: "err", text: `Файлът не може да се прочете: ${errText(e)}` });
    }
  }

  async function doImport() {
    if (!imp?.length) return;
    setImpBusy(true);
    const { data, error } = await supabase.rpc("import_trip_workbook", { p_plate: imp[imp.length - 1].plate, p_months: imp });
    setImpBusy(false);
    if (error) return setImpMsg({ kind: "err", text: errText(error) });
    const d = data as { months: number; refuels_inserted: number; refuels_skipped_months: string[] };
    setImpMsg({
      kind: "ok",
      text: `Импортирани ${d.months} месеца. Зареждания от файла: ${d.refuels_inserted}.` +
        (d.refuels_skipped_months?.length ? ` За ${d.refuels_skipped_months.join(", ")} зарежданията са взети от Лукойл, не от файла.` : ""),
    });
    setImp(null);
    load();
  }

  // Изчисления
  const refByDay = useMemo(() => {
    const m: Record<string, RefuelLite[]> = {};
    for (const r of refuels) (m[r.ts.slice(0, 10)] ??= []).push(r);
    return m;
  }, [refuels]);

  const calc = useMemo(() => {
    let rest = toNum(opening) ?? 0;
    let km = 0, cons = 0, ref = 0;
    const out = days.map((d) => {
      const r = rows[d] ?? { driver: "", km: "", norm: "" };
      const k = toNum(r.km) ?? 0;
      const n = toNum(r.norm) ?? veh?.norm_l_100km ?? 0;
      const c = (k * n) / 100;
      const f = (refByDay[d] ?? []).reduce((a, x) => a + Number(x.liters), 0);
      rest = rest + f - c;
      km += k; cons += c; ref += f;
      return { d, r, k, n, c, f, rest };
    });
    return { out, km, cons, ref, closing: rest };
  }, [days, rows, opening, refByDay, veh]);

  const noNorm = !veh?.norm_l_100km && calc.out.some((x) => x.k > 0 && !toNum(x.r.norm));

  async function save() {
    if (!plate) return;
    setBusy(true);
    const p_days = days
      .map((d) => ({ day: d, ...(rows[d] ?? { driver: "", km: "", norm: "" }) }))
      .filter((r) => r.driver.trim() || r.km.trim() || r.norm.trim())
      .map((r) => ({ day: r.day, driver: r.driver.trim(), km: toNum(r.km) ?? "", norm: toNum(r.norm) ?? "" }));
    const { error } = await supabase.rpc("save_trip_month", {
      p_plate: plate, p_month: month, p_days,
      p_odometer_start: toNum(odoStart), p_opening: toNum(opening),
      p_km: calc.km, p_refueled: Math.round(calc.ref * 1000) / 1000,
      p_consumed: Math.round(calc.cons * 1000) / 1000, p_closing: Math.round(calc.closing * 1000) / 1000,
    });
    setBusy(false);
    if (error) return setMsg({ kind: "err", text: errText(error) });
    setDirty(false);
    setMsg({ kind: "ok", text: `Записано: ${plate}, ${month}. Остатък в края: ${fmt(calc.closing, 3)} л.` });
  }

  function exportXlsx() {
    downloadXlsx(
      calc.out.map((x) => ({
        Дата: x.d.split("-").reverse().join("."), "Изминати км": x.k || "",
        "Норма л/100": x.k ? x.n : "", "Заредено л": x.f || "", "Изразходено л": x.k ? Math.round(x.c * 1000) / 1000 : "",
        "Остатък л": Math.round(x.rest * 1000) / 1000,
      })),
      month,
      `patni_list_${plate}_${month}.xlsx`,
    );
  }

  const odoEnd = toNum(odoStart) !== null ? (toNum(odoStart) as number) + calc.km : null;

  return (
    <div>
      <div className="page-head">
        <h2>Пътни листове (без GPS)</h2>
      </div>
      <p className="muted">
        За колите без GPS: дневни км. Зарежданията идват автоматично от Лукойл и ръчните. Можеш да поставиш от Excel колоните
        <b> Дата | Км</b> (Cmd/Ctrl+V в която и да е клетка; колона с шофьор се игнорира).
      </p>

      <div className="toolbar">
        <button className="btn" onClick={() => setShowImport((x) => !x)}>
          {showImport ? "Скрий импорта" : "Импорт на цял Excel файл (всички месеци)"}
        </button>
      </div>
      {showImport && (
        <div className="card">
          <h3>Импорт от файла „справка за изразходено гориво“</h3>
          <p className="muted small">
            Един лист на месец (01.2026, 02.2026…). Взимат се км, нормата за всеки ден (от формулата), остатъците и
            километража. Зарежданията от файла се записват само за месеци без данни от Лукойл. Повторен импорт презаписва.
          </p>
          <input type="file" accept=".xlsx,.xls" onChange={(e) => onImportFile(e.target.files?.[0])} />
          {impMsg && <Notice kind={impMsg.kind}>{impMsg.text}</Notice>}
          {imp && (
            <>
              <table className="grid compact" style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>Месец</th><th>Кола</th><th className="num">Км към 1-во</th><th className="num">Нач. остатък</th>
                    <th className="num">Км</th><th className="num">Заредено</th><th className="num">Изразходено</th>
                    <th className="num">Остатък</th><th>Проверка</th>
                  </tr>
                </thead>
                <tbody>
                  {imp.map((m) => (
                    <tr key={m.month} className={m.warnings.length ? "row-warn" : ""}>
                      <td>{m.month}</td><td className="mono">{m.plate}</td>
                      <td className="num">{fmt(m.odometer_start, 0)}</td><td className="num">{fmt(m.opening, 3)}</td>
                      <td className="num">{fmt(m.km, 0)}</td><td className="num">{fmt(m.refueled)}</td>
                      <td className="num">{fmt(m.consumed, 3)}</td>
                      <td className={`num ${m.closing < 0 ? "err-t strong" : ""}`}>{fmt(m.closing, 3)}</td>
                      <td className="small">{m.warnings.length ? m.warnings.map((w) => <div key={w} className="warn-t">⚠ {w}</div>) : <span className="ok-t">✓</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="toolbar">
                <button className="btn primary" onClick={doImport} disabled={impBusy}>
                  {impBusy ? "Импортиране…" : `Импортирай ${imp.length} месеца от ${impFile}`}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="toolbar">
        <label>
          Кола
          <select value={plate} onChange={(e) => setPlate(e.target.value)} style={{ minWidth: 260 }}>
            <optgroup label="Без GPS">
              {vehicles.filter((v) => !v.has_gps).map((v) => (
                <option key={v.plate} value={v.plate}>{v.plate} – {v.model ?? ""}</option>
              ))}
            </optgroup>
            <optgroup label="С GPS">
              {vehicles.filter((v) => v.has_gps).map((v) => (
                <option key={v.plate} value={v.plate}>{v.plate} – {v.model ?? ""}</option>
              ))}
            </optgroup>
          </select>
        </label>
        <label>
          Месец
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </label>
        <label>
          Километраж към 01.{month.slice(5)}
          <input className="num" value={odoStart} onChange={(e) => { setOdoStart(e.target.value); setDirty(true); }} style={{ width: 110 }} />
        </label>
        <label>
          Остатък гориво в началото (л)
          <input className="num" value={opening} onChange={(e) => { setOpening(e.target.value); setDirty(true); }} style={{ width: 110 }} title={openingHint} />
        </label>
        <span className="spacer" />
        <button className="btn" onClick={exportXlsx}>Excel</button>
        <button className="btn primary" onClick={save} disabled={busy || !plate}>
          {busy ? "Записване…" : dirty ? "Запиши ●" : "Запиши"}
        </button>
      </div>
      <p className="muted small">{openingHint}{veh ? ` · норма на колата: ${veh.norm_l_100km ?? "не е въведена"} л/100 км` : ""}</p>

      {noNorm && <Notice kind="warn">Колата няма въведена норма в „Машини“. Въведи я там или попълни колона „Норма“ по дни.</Notice>}
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}

      <div className="stats">
        <div><b>{fmt(calc.km, 0)}</b><span>км за месеца</span></div>
        <div><b>{fmt(calc.ref)} л</b><span>заредено</span></div>
        <div><b>{fmt(calc.cons, 3)} л</b><span>изразходено</span></div>
        <div><b>{fmt(calc.closing, 3)} л</b><span>остатък в края</span></div>
        <div><b>{calc.km ? fmt((calc.cons / calc.km) * 100, 2) : "—"}</b><span>ср. л/100 км</span></div>
        <div><b>{odoEnd !== null ? fmt(odoEnd, 0) : "—"}</b><span>километраж в края</span></div>
      </div>

      <div className="table-wrap">
        <table className="grid compact editable">
          <thead>
            <tr>
              <th>Дата</th><th className="num">Км</th><th className="num">Норма</th>
              <th className="num">Заредено л</th><th className="num">Изразходено л</th><th className="num">Остатък л</th><th>Зареждания</th>
            </tr>
          </thead>
          <tbody>
            {calc.out.map((x, i) => {
              const wd = new Date(x.d + "T12:00:00").getDay();
              const r = x.r;
              return (
                <tr key={x.d} className={wd === 0 || wd === 6 ? "weekend" : ""}>
                  <td className="nowrap">{x.d.slice(8)}.{x.d.slice(5, 7)} <span className="muted small">{WD[wd]}</span></td>
                  <td><input className="num" value={r.km} onChange={(e) => setCell(x.d, "km", e.target.value)} onPaste={(e) => onPaste(e, i, "km")} style={{ width: 70 }} /></td>
                  <td>
                    <input className="num" value={r.norm} placeholder={veh?.norm_l_100km != null ? String(veh.norm_l_100km) : ""}
                      onChange={(e) => setCell(x.d, "norm", e.target.value)} onPaste={(e) => onPaste(e, i, "norm")} style={{ width: 55 }} />
                  </td>
                  <td className="num">{x.f ? fmt(x.f) : ""}</td>
                  <td className="num">{x.k ? fmt(x.c, 3) : ""}</td>
                  <td className={`num ${x.rest < 0 ? "err-t strong" : ""}`}>{fmt(x.rest, 3)}</td>
                  <td className="small muted">
                    {(refByDay[x.d] ?? []).map((f, j) => (
                      <div key={j}>{fmtTs(f.ts).slice(11)} {fmt(f.liters)} л {f.station ?? ""}{f.source === "manual" ? " (ръчно)" : ""}</div>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td className="strong">ОБЩО</td>
              <td className="num strong">{fmt(calc.km, 0)}</td><td></td>
              <td className="num strong">{fmt(calc.ref)}</td>
              <td className="num strong">{fmt(calc.cons, 3)}</td>
              <td className="num strong">{fmt(calc.closing, 3)}</td><td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
