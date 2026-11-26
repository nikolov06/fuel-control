import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import type { Refuel } from "../lib/types";
import { Notice, errText, fmt, fmtTs, monthRange, prevMonth, downloadXlsx } from "../lib/ui";
import { normalizePlate } from "../lib/lukoilParser.ts";

export default function Refuels() {
  const [month, setMonth] = useState(prevMonth());
  const [rows, setRows] = useState<Refuel[]>([]);
  const [known, setKnown] = useState<Set<string>>(new Set());
  const [source, setSource] = useState("");
  const [q, setQ] = useState("");
  const [onlyOurs, setOnlyOurs] = useState(true);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const [from, to] = monthRange(month);
    const [r, v] = await Promise.all([
      supabase.from("refuels").select("*").gte("ts", from).lt("ts", to).order("ts").limit(5000),
      supabase.from("vehicles").select("plate"),
    ]);
    setLoading(false);
    if (r.error) return setMsg({ kind: "err", text: errText(r.error) });
    setRows((r.data ?? []) as Refuel[]);
    setKnown(new Set((v.data ?? []).map((x: { plate: string }) => x.plate)));
  }
  useEffect(() => {
    load();
  }, [month]);

  const shown = useMemo(() => {
    const p = normalizePlate(q);
    return rows.filter(
      (r) =>
        (!onlyOurs || (r.plate && known.has(r.plate))) &&
        (!source || r.source === source) &&
        (!p || (r.plate ?? "").includes(p)),
    );
  }, [rows, known, onlyOurs, source, q]);

  const totals = useMemo(() => {
    const t: Record<string, number> = {};
    for (const r of shown) t[r.fuel_category ?? "?"] = (t[r.fuel_category ?? "?"] ?? 0) + Number(r.liters);
    return t;
  }, [shown]);

  async function del(r: Refuel) {
    if (!window.confirm(`Да изтрия ли ръчното зареждане ${r.plate} ${fmtTs(r.ts)} ${fmt(r.liters)} л?`)) return;
    const { error } = await supabase.from("refuels").delete().eq("id", r.id);
    if (error) return setMsg({ kind: "err", text: errText(error) });
    setMsg({ kind: "ok", text: "Изтрито." });
    load();
  }

  function exportXlsx() {
    downloadXlsx(
      shown.map((r) => ({
        "Рег. номер": r.plate, "Дата и час": fmtTs(r.ts), Вид: r.fuel_category, Стока: r.product, Литри: Number(r.liters),
        "Ед. цена": r.unit_price, Стойност: r.amount, Бензиностанция: r.station, "Фирма (карта)": r.company, Карта: r.card,
        Източник: r.source, Файл: r.source_file,
      })),
      month,
      `zarejdania_${month}.xlsx`,
    );
  }

  return (
    <div>
      <div className="page-head">
        <h2>Зареждания</h2>
        <span className="muted">{shown.length} реда</span>
      </div>
      <div className="toolbar">
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">Всички източници</option>
          <option value="lukoil">Лукойл</option>
          <option value="manual">Ръчни</option>
          <option value="putni_list">Пътни листове</option>
        </select>
        <input placeholder="Рег. номер" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 130 }} />
        <label className="check">
          <input type="checkbox" checked={onlyOurs} onChange={(e) => setOnlyOurs(e.target.checked)} /> само нашите машини
        </label>
        <span className="spacer" />
        <button className="btn" onClick={exportXlsx}>Excel</button>
      </div>
      <div className="stats">
        {Object.entries(totals).map(([k, v]) => (
          <div key={k}>
            <b>{fmt(v)} л</b>
            <span>{k}</span>
          </div>
        ))}
      </div>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      {loading ? (
        <p className="muted">Зареждане…</p>
      ) : (
        <div className="table-wrap">
          <table className="grid compact">
            <thead>
              <tr>
                <th>Рег. номер</th><th>Дата и час</th><th>Стока</th><th className="num">Литри</th><th className="num">Стойност</th>
                <th>Бензиностанция</th><th>Фирма (карта)</th><th>Източник</th><th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className={r.plate && known.has(r.plate) ? "" : "dim"}>
                  <td className="mono">{r.plate}</td>
                  <td>{fmtTs(r.ts)}</td>
                  <td><span className={`cat cat-${r.fuel_category}`}>{r.product}</span></td>
                  <td className="num">{fmt(r.liters)}</td>
                  <td className="num">{fmt(r.amount)}</td>
                  <td>{r.station}</td>
                  <td>{r.company}</td>
                  <td>{r.source === "manual" ? "ръчно" : r.source === "putni_list" ? "пътен лист" : "Лукойл"}</td>
                  <td>
                    {r.source === "manual" && (
                      <button className="btn small danger" onClick={() => del(r)}>Изтрий</button>
                    )}
                  </td>
                </tr>
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={9} className="muted center">Няма зареждания за {month}.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
