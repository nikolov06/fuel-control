import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import type { UnmatchedRow } from "../lib/types";
import { Notice, errText, fmt } from "../lib/ui";

export default function Unmatched() {
  const [rows, setRows] = useState<UnmatchedRow[]>([]);
  const [month, setMonth] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const { data, error } = await supabase.from("v_unmatched_refuels").select("*").order("month", { ascending: false }).order("liters", { ascending: false });
    setLoading(false);
    if (error) return setMsg({ kind: "err", text: errText(error) });
    setRows((data ?? []) as UnmatchedRow[]);
  }
  useEffect(() => {
    load();
  }, []);

  const months = useMemo(() => [...new Set(rows.map((r) => r.month))], [rows]);
  const shown = rows.filter((r) => !month || r.month === month);

  async function addAsOurs(r: UnmatchedRow) {
    if (!r.plate) return;
    const { error } = await supabase.from("vehicles").insert({ plate: r.plate, company: null, has_gps: false, note: `добавена от зареждания (${r.company ?? ""})` });
    if (error) return setMsg({ kind: "err", text: errText(error) });
    setMsg({ kind: "ok", text: `${r.plate} е добавена в Машини. Зарежданията ѝ вече влизат в сметката. Попълни фирмата и останалото в „Машини“.` });
    load();
  }

  return (
    <div>
      <div className="page-head">
        <h2>Неразпознати номера</h2>
      </div>
      <p className="muted">
        Зареждания за МПС, които ги няма в „Машини“. Обикновено са на чужди фирми и не пречат. Ако някоя е ваша (напр. кола без GPS),
        добави я и зарежданията ѝ ще влязат в сметката.
      </p>
      <div className="toolbar">
        <select value={month} onChange={(e) => setMonth(e.target.value)}>
          <option value="">Всички месеци</option>
          {months.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </div>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      {loading ? (
        <p className="muted">Зареждане…</p>
      ) : (
        <div className="table-wrap">
          <table className="grid compact">
            <thead>
              <tr>
                <th>Рег. номер</th><th>Както е във файла</th><th>Фирма (по картата)</th><th>Месец</th>
                <th className="num">Зареждания</th><th className="num">Литри</th><th className="num">Стойност</th><th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={`${r.plate}-${r.month}`}>
                  <td className="mono strong">{r.plate}</td>
                  <td>{r.plate_raw}</td>
                  <td>{r.company}</td>
                  <td>{r.month}</td>
                  <td className="num">{r.rows}</td>
                  <td className="num">{fmt(r.liters)}</td>
                  <td className="num">{fmt(r.amount)}</td>
                  <td>
                    <button className="btn small" onClick={() => addAsOurs(r)}>
                      Наша е → добави
                    </button>
                  </td>
                </tr>
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={8} className="muted center">Няма неразпознати номера.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
