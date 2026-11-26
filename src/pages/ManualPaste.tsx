import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { parsePasted, validateAgainst, toImportRows } from "../lib/pasteParser.ts";
import type { FuelCategory } from "../lib/lukoilParser.ts";
import { Notice, errText, fmt, fmtTs } from "../lib/ui";

export default function ManualPaste() {
  const [text, setText] = useState("");
  const [station, setStation] = useState("");
  const [fuel, setFuel] = useState<FuelCategory | "">("");
  const [year, setYear] = useState(new Date().getFullYear());
  const [known, setKnown] = useState<Set<string>>(new Set());
  const [fuelByPlate, setFuelByPlate] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    supabase
      .from("vehicles")
      .select("plate,fuel_type")
      .then(({ data }) => {
        const d = (data ?? []) as { plate: string; fuel_type: string | null }[];
        setKnown(new Set(d.map((r) => r.plate)));
        setFuelByPlate(new Map(d.filter((r) => r.fuel_type).map((r) => [r.plate, r.fuel_type as string])));
      });
  }, []);

  const parsed = useMemo(() => {
    if (!text.trim()) return null;
    const res = parsePasted(text, { station: station.trim() || undefined, fuelDefault: fuel || undefined, year });
    validateAgainst(res.rows, known, fuelByPlate);
    return res;
  }, [text, station, fuel, year, known, fuelByPlate]);

  const okRows = parsed ? toImportRows(parsed.rows) : [];
  const errCount = parsed ? parsed.rows.filter((r) => r.errors.length).length : 0;
  const litersOk = okRows.reduce((a, r) => a + (r.liters ?? 0), 0);

  async function doImport() {
    if (!okRows.length) return;
    setBusy(true);
    setMsg(null);
    const label = `Ръчно${station ? " " + station : ""} ${new Date().toLocaleDateString("bg-BG")}`;
    const { data, error } = await supabase.rpc("import_refuels", { p_rows: okRows, p_file: label, p_source: "manual" });
    setBusy(false);
    if (error) return setMsg({ kind: "err", text: errText(error) });
    const d = data as { inserted: number; duplicates: number };
    setMsg({ kind: "ok", text: `Записани ${d.inserted} реда${d.duplicates ? `, ${d.duplicates} вече ги имаше` : ""}.` });
    if (!errCount) setText("");
  }

  return (
    <div>
      <div className="page-head">
        <a className="btn" href="/sablon_rachni_zarejdania.xlsx" download="Шаблон_ръчни_зареждания.xlsx">
          Свали шаблон
        </a>
      </div>
      <p className="muted">
        Маркирай таблицата в Excel заедно със заглавния ред → Ctrl/Cmd+C → постави тук. Колоните се разпознават по заглавията.
      </p>

      <div className="toolbar">
        <label>
          Бензиностанция по подразбиране
          <input value={station} onChange={(e) => setStation(e.target.value)} placeholder="напр. Петрол Ген. Тошево" style={{ width: 220 }} />
        </label>
        <label>
          Гориво по подразбиране
          <select value={fuel} onChange={(e) => setFuel(e.target.value as FuelCategory | "")}>
            <option value="">— от таблицата —</option>
            <option>Дизел</option>
            <option>Бензин</option>
          </select>
        </label>
        <label>
          Година (ако датите са без година)
          <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 80 }} />
        </label>
      </div>

      <textarea
        className="paste"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"Рег. номер\tДата\tЧас\tГориво\tЛитри\tСтойност\tБензиностанция\tБон\nСВ 6307 ВТ\t15.10.2026\t08:15\tДизел\t45,5\t86,45\tПетрол\t000123"}
        spellCheck={false}
      />

      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}

      {parsed && (
        <>
          <div className="toolbar">
            <span>
              <b>{parsed.rows.length}</b> реда · <b className="ok-t">{okRows.length}</b> за запис ({fmt(litersOk)} л)
              {errCount > 0 && (
                <>
                  {" "}· <b className="err-t">{errCount}</b> с грешка (няма да се запишат)
                </>
              )}
              {!parsed.headerDetected && <span className="muted"> · без заглавен ред: ползвам реда от шаблона</span>}
            </span>
            <span className="spacer" />
            <button className="btn primary" disabled={!okRows.length || busy} onClick={doImport}>
              {busy ? "Записване…" : `Запиши ${okRows.length} реда`}
            </button>
          </div>
          <div className="table-wrap">
            <table className="grid compact">
              <thead>
                <tr>
                  <th>#</th><th>Рег. номер</th><th>Дата и час</th><th>Гориво</th><th className="num">Литри</th>
                  <th className="num">Стойност</th><th>Бензиностанция</th><th>Бон</th><th>Бележки</th>
                </tr>
              </thead>
              <tbody>
                {parsed.rows.map((r) => (
                  <tr key={r.line} className={r.errors.length ? "row-err" : r.warnings.length ? "row-warn" : ""}>
                    <td className="muted">{r.line}</td>
                    <td className="mono">{r.plate || r.plate_raw}</td>
                    <td>{fmtTs(r.ts)}</td>
                    <td><span className={`cat cat-${r.fuel_category}`}>{r.product}</span></td>
                    <td className="num">{fmt(r.liters)}</td>
                    <td className="num">{fmt(r.amount)}</td>
                    <td>{r.station}</td>
                    <td>{r.receipt_no}</td>
                    <td className="small">
                      {r.errors.map((e) => (
                        <div key={e} className="err-t">✖ {e}</div>
                      ))}
                      {r.warnings.map((w) => (
                        <div key={w} className="warn-t">⚠ {w}</div>
                      ))}
                    </td>
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
