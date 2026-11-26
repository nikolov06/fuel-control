import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { parseLukoilRows, summarize } from "../lib/lukoilParser.ts";
import type { ParseResult } from "../lib/lukoilParser.ts";
import { Notice, errText, fmt, fmtTs, readSheetRows } from "../lib/ui";

interface ImportResult {
  total: number;
  inserted: number;
  duplicates: number;
  matched_rows: number;
  unmatched_rows: number;
}

export default function LukoilImport() {
  const [known, setKnown] = useState<Set<string>>(new Set());
  const [fileName, setFileName] = useState("");
  const [res, setRes] = useState<ParseResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [onlyOurs, setOnlyOurs] = useState(true);

  useEffect(() => {
    supabase
      .from("vehicles")
      .select("plate")
      .then(({ data }) => setKnown(new Set((data ?? []).map((r: { plate: string }) => r.plate))));
  }, []);

  async function onFile(f: File | undefined) {
    setErr(null);
    setDone(null);
    setRes(null);
    if (!f) return;
    setFileName(f.name);
    try {
      const parsed = parseLukoilRows(await readSheetRows(f));
      if (!parsed.rows.length) setErr("Не намерих редове със зареждания. Това ли е справката от Лукойл?");
      setRes(parsed);
    } catch (e) {
      setErr(`Файлът не може да се прочете: ${errText(e)}`);
    }
  }

  const sum = useMemo(() => (res ? summarize(res) : null), [res]);

  // По фирми: наши / чужди редове
  const byCompany = useMemo(() => {
    const m = new Map<string, { ours: number; foreign: number; liters: number }>();
    for (const r of res?.rows ?? []) {
      const k = r.company ?? "(без фирма)";
      const s = m.get(k) ?? { ours: 0, foreign: 0, liters: 0 };
      if (known.has(r.plate)) s.ours++;
      else s.foreign++;
      s.liters += r.liters;
      m.set(k, s);
    }
    return [...m];
  }, [res, known]);

  const rows = (res?.rows ?? []).filter((r) => !onlyOurs || known.has(r.plate));

  async function doImport() {
    if (!res) return;
    setBusy(true);
    setErr(null);
    const { data, error } = await supabase.rpc("import_lukoil", { p_rows: res.rows, p_file: fileName });
    setBusy(false);
    if (error) return setErr(errText(error));
    setDone(data as ImportResult);
  }

  return (
    <div>
      <p className="muted">Качи „Справка за включени покупки във фактура“ (.xlsx). Преди запис ще видиш какво е разпознато.</p>

      <div className="toolbar">
        <input type="file" accept=".xlsx,.xls" onChange={(e) => onFile(e.target.files?.[0])} />
      </div>

      {err && <Notice kind="err">{err}</Notice>}

      {res && sum && (
        <>
          <div className="stats">
            <div><b>{res.invoiceNo ?? "—"}</b><span>фактура{res.invoiceDate ? ` / ${res.invoiceDate.split("-").reverse().join(".")}` : ""}</span></div>
            <div><b>{sum.rows}</b><span>реда</span></div>
            <div><b>{sum.vehicles}</b><span>МПС</span></div>
            {Object.entries(sum.byCategory).map(([cat, s]) => (
              <div key={cat}>
                <b>{fmt(s.liters)} л</b>
                <span>{cat} ({s.count})</span>
              </div>
            ))}
          </div>

          {sum.nonFuel.length > 0 && (
            <Notice kind="warn">
              Непаливни покупки (не влизат в разхода):{" "}
              {sum.nonFuel.map((r) => `${r.plate_raw} – ${r.product} ${fmt(r.amount)}`).join("; ")}
            </Notice>
          )}
          {res.skipped.length > 0 && (
            <Notice kind="warn">Пропуснати редове: {res.skipped.map((s) => `ред ${s.row} (${s.reason})`).join(", ")}</Notice>
          )}

          <table className="grid compact" style={{ maxWidth: 620 }}>
            <thead>
              <tr><th>Фирма (по картата)</th><th className="num">Наши МПС</th><th className="num">Непознати</th><th className="num">Литри</th></tr>
            </thead>
            <tbody>
              {byCompany.map(([c, s]) => (
                <tr key={c} className={s.ours === 0 ? "dim" : ""}>
                  <td>{c}</td><td className="num">{s.ours}</td><td className="num">{s.foreign}</td><td className="num">{fmt(s.liters)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">„Непознати“ са МПС, които ги няма в Машини. Записват се, но не влизат в сметката.</p>

          {done ? (
            <Notice kind="ok">
              Готово: записани {done.inserted} нови реда, {done.duplicates} вече ги имаше (повторно качване). За наши машини:{" "}
              {done.matched_rows}, за непознати: {done.unmatched_rows}.
            </Notice>
          ) : (
            <div className="toolbar">
              <button className="btn primary" onClick={doImport} disabled={busy}>
                {busy ? "Записване…" : `Импортирай ${res.rows.length} реда`}
              </button>
            </div>
          )}

          <div className="toolbar">
            <label className="check">
              <input type="checkbox" checked={onlyOurs} onChange={(e) => setOnlyOurs(e.target.checked)} /> покажи само нашите машини
            </label>
            <span className="muted small">{rows.length} реда</span>
          </div>
          <div className="table-wrap">
            <table className="grid compact">
              <thead>
                <tr>
                  <th>Рег. номер</th><th>Фирма</th><th>Дата и час</th><th>Стока</th><th>Вид</th>
                  <th className="num">Литри</th><th className="num">Стойност</th><th>Бензиностанция</th><th>Карта</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={known.has(r.plate) ? "" : "dim"}>
                    <td className="mono">{r.plate}{!known.has(r.plate) && <span className="tag">непозната</span>}</td>
                    <td>{r.company}</td>
                    <td>{fmtTs(r.ts)}</td>
                    <td>{r.product}</td>
                    <td><span className={`cat cat-${r.fuel_category}`}>{r.fuel_category}</span></td>
                    <td className="num">{fmt(r.liters)}</td>
                    <td className="num">{fmt(r.amount)}</td>
                    <td>{r.station}</td>
                    <td className="mono small">{r.card}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
