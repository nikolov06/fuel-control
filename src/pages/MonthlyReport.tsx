import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { Notice, errText, fmt, prevMonth, downloadXlsx } from "../lib/ui";

type Row = Record<string, string | number | null>;

const NUM_COLS: [string, number][] = [
  ["Км", 0], ["Гориво начало (л)", 1], ["Заредено (л)", 2], ["Гориво край (л)", 1], ["Изразходвано (л)", 2],
  ["л/100 км", 2], ["Норма л/100км", 2], ["Откл. от норма %", 1], ["CAN разход (л)", 1], ["Стойност зареждания", 2],
];

export default function MonthlyReport() {
  const [month, setMonth] = useState(prevMonth());
  const [rows, setRows] = useState<Row[]>([]);
  const [company, setCompany] = useState("");
  const [onlyFlags, setOnlyFlags] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    supabase
      .from("v_monthly_fuel")
      .select("*")
      .eq("Месец", month)
      .then(({ data, error }) => {
        setLoading(false);
        if (error) return setErr(errText(error));
        setErr(null);
        setRows((data ?? []) as Row[]);
      });
  }, [month]);

  const companies = useMemo(() => [...new Set(rows.map((r) => r["Фирма"] as string | null))], [rows]);

  const shown = useMemo(
    () =>
      rows
        .filter((r) => (company === "" ? r["Фирма"] !== null : company === "—" ? r["Фирма"] === null : r["Фирма"] === company))
        .filter((r) => !onlyFlags || r["Бележки"])
        .sort((a, b) => String(a["Фирма"] ?? "яя").localeCompare(String(b["Фирма"] ?? "яя")) || String(a["Рег. номер"]).localeCompare(String(b["Рег. номер"]))),
    [rows, company, onlyFlags],
  );

  const tot = (k: string) => shown.reduce((a, r) => a + (Number(r[k]) || 0), 0);

  return (
    <div>
      <div className="page-head">
        <h2>Месечна справка</h2>
        <span className="muted">км и гориво по GPS + зареждания</span>
      </div>
      <div className="toolbar">
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        <select value={company} onChange={(e) => setCompany(e.target.value)}>
          <option value="">Всички фирми (без техниката)</option>
          {companies.filter((c): c is string => !!c).sort().map((c) => (
            <option key={c}>{c}</option>
          ))}
          <option value="—">Без фирма (камиони, техника)</option>
        </select>
        <label className="check">
          <input type="checkbox" checked={onlyFlags} onChange={(e) => setOnlyFlags(e.target.checked)} /> само с бележки
        </label>
        <span className="spacer" />
        <button className="btn" onClick={() => downloadXlsx(shown, month, `spravka_${month}.xlsx`)} disabled={!shown.length}>
          Excel
        </button>
      </div>
      <div className="stats">
        <div><b>{shown.length}</b><span>машини</span></div>
        <div><b>{fmt(tot("Км"), 0)}</b><span>км</span></div>
        <div><b>{fmt(tot("Заредено (л)"))} л</b><span>заредено</span></div>
        <div><b>{fmt(tot("Стойност зареждания"))}</b><span>стойност</span></div>
      </div>
      <Notice kind="info">
        Това е справката по GPS данните. Разпределението за счетоводството (Кол-во / За изписване / Остатък) идва след като изберете начин на изписване.
      </Notice>
      {err && <Notice kind="err">{err}</Notice>}
      {loading ? (
        <p className="muted">Зареждане…</p>
      ) : !rows.length ? (
        <p className="muted">Няма данни за {month}. Трябват снимки от Нетера към края на този и на предходния месец.</p>
      ) : (
        <div className="table-wrap">
          <table className="grid compact">
            <thead>
              <tr>
                <th>Фирма</th><th>Рег. номер</th>
                {NUM_COLS.map(([k]) => (
                  <th key={k} className="num">{k}</th>
                ))}
                <th>Бележки</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={String(r["Рег. номер"])} className={r["Бележки"] ? "row-warn" : ""}>
                  <td className="nowrap">{r["Фирма"]}</td>
                  <td className="mono strong">{r["Рег. номер"]}</td>
                  {NUM_COLS.map(([k, d]) => (
                    <td key={k} className="num">{fmt(r[k], d)}</td>
                  ))}
                  <td className="small notes">{r["Бележки"]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
